/**
 * DHL Express Router
 *
 * Eigenständiger Express-Router für die DHL Geschäftskunden-Integration.
 * Additive Labelhistorie; keine Status-/Bestands-/Zahlungs-/Kommunikationsänderungen.
 * DHL ist eine additive Versandoption neben dem manuellen Workflow
 * und der Sendcloud-Integration.
 *
 * Endpoints:
 *   POST /api/shipping/dhl/create-label     – DHL-Label für eine Bestellung erstellen
 *   GET  /api/shipping/dhl/label/:orderId   – Label-PDF abrufen (aus DB, kein DHL-Call)
 *   GET  /api/shipping/dhl/status           – Konfigurationsstatus prüfen (kein DHL-Call)
 *
 * Label-Speicherung:
 *   - Base64-PDF wird in orders.shippingLabelContent (TEXT) gespeichert
 *   - orders.shippingLabelUrl wird auf /api/shipping/dhl/label/{orderId} gesetzt
 *   - Download-Route liest aus DB, decoded Base64 → Buffer → PDF-Response
 *
 * Durable generations + operation ledger under a shared per-order transaction lock.
 * Pending/unknown external outcomes NEVER expire or permit blind retries.
 * Explicit cancel/attest/replace routes are documented in docs/DHL_RELABEL_CONTRACT.md.
 * Cancellation preserves order tracking and never reopens an order.
 *
 * Sicherheit:
 *   - Nur eingeloggte Admin-User dürfen Labels erstellen und abrufen (JWT via getUserFromRequest)
 *   - Keine DHL-Credentials im Response
 */

import { Router, type Request, type Response } from "express";
import { ENV } from "./env.js";
import { normalizeCountryToAlpha3 } from "./dhlService.js";
import { getDhlProfiles, suggestProfile, type DhlProfileKey } from "./dhlProfiles.js";
import { getDb, getPool } from "./db.js";
import { orderItems, orders } from "../drizzle/schema.js";
import { eq } from "drizzle-orm";
import { getUserFromRequest } from "./auth.js";
import { validateSwissCustomsDeclaration, type SwissCustomsDeclaration } from "./swissCustomsService.js";
import { getDhlLabelLifecycleForOrders, isDhlLabelLifecycleUsable } from "./dhlLabelLifecycleSummary.js";
import { restoreSwissCustomsSelection, validateSwissCustomsSelection, type SwissCustomsDraftInput } from "./swissCustomsSelection.js";

import { DhlRelabelService, DhlLabelError } from "./dhlRelabelService.js";
import { PgDhlLabelStore } from "./dhlRelabelStore.js";
import { prepareDhlLabel, requestDhlLabel, buildDhlLabelDocuments } from "./dhlLabelPreparation.js";
import { cancelDhlShipment } from "./dhlCancellationService.js";

export const dhlExpressRouter = Router();

// ─── Middleware: JWT-Auth für Label-Erstellung und -Abruf ────────────────────

export async function requireWawiAdmin(
  req: Request,
  res: Response,
  next: () => void
): Promise<void> {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ success: false, error: "Nicht angemeldet" });
    return;
  }
  if (user.role !== "admin") {
    res.status(403).json({ success: false, error: "Keine Berechtigung – Admin erforderlich" });
    return;
  }
  next();
}

// ─── GET /api/shipping/dhl/status ─────────────────────────────────────────────
// Gibt Konfigurationsstatus zurück ohne DHL-Call.

dhlExpressRouter.get(
  "/api/shipping/dhl/status",
  requireWawiAdmin,
  (_req: Request, res: Response) => {
    const configured =
      !!ENV.dhlApiKey &&
      !!ENV.dhlBusinessUsername &&
      !!ENV.dhlBusinessPassword &&
      !!ENV.dhlBillingNumber;

    res.json({
      configured,
      sandbox:       ENV.dhlSandbox,
      hasApiKey:     !!ENV.dhlApiKey,
      hasUsername:   !!ENV.dhlBusinessUsername,
      hasPassword:   !!ENV.dhlBusinessPassword,
      hasBilling:    !!ENV.dhlBillingNumber,
      billingLength: ENV.dhlBillingNumber?.length ?? 0,
      productCode:   ENV.dhlProductCodeDe,
    });
  }
);

// ─── GET /api/shipping/dhl/availability/:country ──────────────────────────────
// Prüft ausschließlich anhand der zentralen Profilkonfiguration, ob ein Zielland
// aktuell automatisiert über DHL gelabelt werden kann. Kein DHL-Call.
const alpha3ToAlpha2: Record<string, string> = {
  DEU: "DE", AUT: "AT", CHE: "CH", FRA: "FR", NLD: "NL", BEL: "BE", LUX: "LU",
  POL: "PL", CZE: "CZ", SVK: "SK", HUN: "HU", ROU: "RO", BGR: "BG", HRV: "HR",
  SVN: "SI", ITA: "IT", ESP: "ES", PRT: "PT", GRC: "GR", CYP: "CY", MLT: "MT",
  IRL: "IE", FIN: "FI", SWE: "SE", DNK: "DK", EST: "EE", LVA: "LV", LTU: "LT",
  NOR: "NO", ISL: "IS", LIE: "LI",
};

function isSwissDestination(country: string | null | undefined): boolean {
  return normalizeCountryToAlpha3(String(country ?? "")) === "CHE";
}

// ─── Schweizer Zolldaten: nur auftragsbezogen und vollständig ─────────────────

dhlExpressRouter.get(
  "/api/shipping/dhl/swiss-customs/:orderId",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    const db = await getDb();
    if (!db) {
      res.status(503).json({ success: false, error: "Datenbank nicht verfügbar" });
      return;
    }
    const [order] = await db.select().from(orders).where(eq(orders.orderId, orderId)).limit(1);
    if (!order) {
      res.status(404).json({ success: false, error: "Bestellung nicht gefunden" });
      return;
    }
    if (!isSwissDestination(order.country)) {
      res.status(422).json({ success: false, error: "Zolldaten können nur für eine Schweizer Lieferadresse erfasst werden." });
      return;
    }
    const rows = await db.select({
      id: orderItems.id,
      name: orderItems.name,
      dosage: orderItems.dosage,
      variant: orderItems.variant,
      quantity: orderItems.quantity,
    }).from(orderItems).where(eq(orderItems.orderId, orderId));
    const pool = await getPool();
    if (!pool) {
      res.status(503).json({ success: false, error: "Datenbank für Schweizer Zolldaten nicht verfügbar" });
      return;
    }
    const saved = await pool.query(`
      SELECT declaration.package_weight_grams, declaration.compliance_confirmed_at,
             item.order_item_id, item.item_description, item.hs_code, item.country_of_origin, item.unit_weight_grams, item.unit_customs_value_eur
      FROM order_swiss_customs_declarations declaration
      LEFT JOIN order_swiss_customs_items item ON item.declaration_id = declaration.id
      WHERE declaration.order_id = $1
    `, [orderId]);
    const savedByItem = new Map(saved.rows.filter((row) => row.order_item_id).map((row) => [Number(row.order_item_id), row]));
    const declaration = saved.rows[0];
    const selection = restoreSwissCustomsSelection(rows, saved.rows.length > 0, new Set(savedByItem.keys()));
    res.json({
      success: true,
      orderId,
      packageWeightGrams: declaration?.package_weight_grams ? Number(declaration.package_weight_grams) : null,
      complianceConfirmed: Boolean(declaration?.compliance_confirmed_at),
      excludedItems: selection.excludedItems.map((item) => ({
        orderItemId: item.id,
        name: item.name,
        dosage: item.dosage,
        variant: item.variant,
        quantity: item.quantity,
      })),
      items: selection.items.map((item) => {
        const prior = savedByItem.get(item.id);
        return {
          orderItemId: item.id,
          name: item.name,
          dosage: item.dosage,
          variant: item.variant,
          quantity: item.quantity,
          description: prior?.item_description ?? "",
          hsCode: prior?.hs_code ?? "",
          countryOfOrigin: prior?.country_of_origin ?? "",
          unitWeightGrams: prior?.unit_weight_grams ? Number(prior.unit_weight_grams) : null,
          unitCustomsValueEur: prior?.unit_customs_value_eur ? Number(prior.unit_customs_value_eur) : null,
        };
      }),
    });
  },
);

// Handelsrechnungen werden nur gespeichert. Dieser geschützte Abruf erzeugt
// keinen automatischen Druck oder Browser-Popup und ist ausschließlich für
// einen späteren, bewussten WaWi-Download vorgesehen.
dhlExpressRouter.get(
  "/api/shipping/dhl/swiss-customs-invoice/:orderId",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    const pool = await getPool();
    if (!pool) {
      res.status(503).json({ success: false, error: "Datenbank für Schweizer Handelsrechnung nicht verfügbar" });
      return;
    }
    const result = await pool.query(`
      SELECT commercial_invoice_content
      FROM order_swiss_customs_declarations
      WHERE order_id = $1
    `, [orderId]);
    const content = result.rows[0]?.commercial_invoice_content;
    if (!content) {
      res.status(404).json({ success: false, error: "Keine gespeicherte Schweizer Handelsrechnung für diese Bestellung vorhanden" });
      return;
    }
    const buffer = Buffer.from(String(content), "base64");
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="swiss-commercial-invoice-${orderId}.pdf"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, no-cache",
    });
    res.send(buffer);
  }
);

/** Liefert ausschließlich die zwei separat gespeicherten A4-Handelsrechnungen. */
dhlExpressRouter.get(
  "/api/shipping/dhl/swiss-customs-documents/:orderId",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    const pool = await getPool();
    if (!pool) {
      res.status(503).json({ success: false, error: "Datenbank für Schweizer Zolldokumente nicht verfügbar" });
      return;
    }
    const result = await pool.query(`
      SELECT commercial_invoice_content
      FROM order_swiss_customs_declarations
      WHERE order_id = $1
    `, [orderId]);
    const content = result.rows[0]?.commercial_invoice_content;
    if (!content) {
      res.status(404).json({ success: false, error: "Keine gespeicherten Schweizer Handelsrechnungen für diese Bestellung vorhanden" });
      return;
    }
    const buffer = Buffer.from(String(content), "base64");
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="swiss-commercial-invoices-${orderId}.pdf"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, no-cache",
    });
    res.send(buffer);
  }
);

dhlExpressRouter.put(
  "/api/shipping/dhl/swiss-customs/:orderId",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    const body = (req.body ?? {}) as SwissCustomsDraftInput;
    const db = await getDb();
    const user = await getUserFromRequest(req);
    if (!db || !user) {
      res.status(503).json({ success: false, error: "Datenbank oder Sitzung nicht verfügbar" });
      return;
    }
    const [order] = await db.select().from(orders).where(eq(orders.orderId, orderId)).limit(1);
    if (!order) {
      res.status(404).json({ success: false, error: "Bestellung nicht gefunden" });
      return;
    }
    if (order.trackingNumber || order.shippingLabelUrl) {
      res.status(409).json({ success: false, error: "Zolldaten können nach der Label-Erstellung nicht mehr geändert werden." });
      return;
    }
    if (!isSwissDestination(order.country)) {
      res.status(422).json({ success: false, error: "Zolldaten können nur für eine Schweizer Lieferadresse erfasst werden." });
      return;
    }
    if (body.complianceConfirmed !== true) {
      res.status(422).json({ success: false, error: "Bitte bestätige, dass keine Verbote, Beschränkungen oder Ausfuhrgenehmigungen vorliegen." });
      return;
    }
    const existingItems = await db.select({ id: orderItems.id, quantity: orderItems.quantity })
      .from(orderItems).where(eq(orderItems.orderId, orderId));
    const selection = validateSwissCustomsSelection(existingItems, body.items, body.excludedOrderItemIds);
    if (!selection.ok) {
      res.status(422).json({ success: false, error: selection.error });
      return;
    }
    const draft: SwissCustomsDeclaration = {
      orderId,
      packageWeightGrams: Number(body.packageWeightGrams),
      shippingEur: Number(order.shipping ?? 0),
      subtotalEur: Number(order.subtotal ?? 0),
      discountEur: Number(order.discount ?? 0),
      lines: selection.lines,
    };
    const validated = validateSwissCustomsDeclaration(draft);
    if (!validated.ok) {
      res.status(422).json({ success: false, error: validated.error });
      return;
    }
    if (validated.value.goodsValueEur > 1000) {
      res.status(422).json({ success: false, error: "Warenwert über 1.000 €: Die notwendige Ausfuhranmeldung/ABD wird nicht automatisch erstellt." });
      return;
    }
    const pool = await getPool();
    if (!pool) {
      res.status(503).json({ success: false, error: "Datenbank für Schweizer Zolldaten nicht verfügbar" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const declarationResult = await client.query(`
        INSERT INTO order_swiss_customs_declarations (
          order_id, package_weight_grams, shipping_terms, invoice_number,
          compliance_confirmed_at, compliance_confirmed_by, created_by, updated_at
        ) VALUES ($1, $2, 'DAP', $3, NOW(), $4, $4, NOW())
        ON CONFLICT (order_id) DO UPDATE SET
          package_weight_grams = EXCLUDED.package_weight_grams,
          compliance_confirmed_at = EXCLUDED.compliance_confirmed_at,
          compliance_confirmed_by = EXCLUDED.compliance_confirmed_by,
          updated_at = NOW()
        RETURNING id
      `, [orderId, validated.value.packageWeightGrams, `CH-${orderId}`, user.name || user.username || "admin"]);
      const declarationId = Number(declarationResult.rows[0].id);
      await client.query("DELETE FROM order_swiss_customs_items WHERE declaration_id = $1", [declarationId]);
      for (const line of validated.value.lines) {
        await client.query(`
          INSERT INTO order_swiss_customs_items (
            declaration_id, order_item_id, item_description, hs_code, country_of_origin, unit_weight_grams, unit_customs_value_eur, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        `, [declarationId, line.orderItemId, line.description, line.hsCode, line.countryOfOrigin, line.unitWeightGrams, line.unitValueEur]);
      }
      await client.query("COMMIT");
      res.json({ success: true, goodsValueEur: validated.value.goodsValueEur, packageWeightGrams: validated.value.packageWeightGrams });
    } catch (error: any) {
      await client.query("ROLLBACK");
      console.error("[dhlRouter/CH] Zolldaten konnten nicht gespeichert werden", error);
      res.status(500).json({ success: false, error: "Zolldaten konnten nicht gespeichert werden." });
    } finally {
      client.release();
    }
  },
);

dhlExpressRouter.get(
  "/api/shipping/dhl/availability/:country",
  requireWawiAdmin,
  (req: Request, res: Response) => {
    const rawCountry = String(req.params.country ?? "").trim();
    const country = alpha3ToAlpha2[normalizeCountryToAlpha3(rawCountry)] ?? rawCountry.toUpperCase();
    const profiles = getDhlProfiles();
    const availableProfiles = (Object.entries(profiles) as Array<[DhlProfileKey, (typeof profiles)[DhlProfileKey]]>)
      .filter(([, profile]) => profile.active && profile.countries.includes(country))
      .map(([key]) => key);
    const suggestedProfile = suggestProfile(country);
    const suggested = suggestedProfile ? profiles[suggestedProfile] : null;

    res.json({
      success: true,
      country,
      autoLabelAvailable: availableProfiles.length > 0,
      availableProfiles,
      suggestedProfile,
      reason: availableProfiles.length > 0
        ? null
        : suggested && !suggested.active
          ? suggested.inactiveReason ?? `DHL-Profil für ${country} ist nicht aktiv`
          : `Kein aktives DHL-Profil für ${country} hinterlegt`,
    });
  },
);

// ─── GET /api/shipping/label/:orderId ─────────────────────────────────────────
// Liefert ein gespeichertes DHL- oder extern hochgeladenes Label geschützt aus,
// ohne große Labeldaten in die Bestellliste zu laden.
dhlExpressRouter.get(
  "/api/shipping/label/:orderId",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    if (!orderId) {
      res.status(400).json({ success: false, error: "orderId fehlt" });
      return;
    }
    const db = await getDb();
    if (!db) {
      res.status(503).json({ success: false, error: "Datenbank nicht verfügbar" });
      return;
    }
    const [order] = await db
      .select({
        shippingLabelContent: (orders as any).shippingLabelContent,
        shippingLabelUrl: (orders as any).shippingLabelUrl,
        trackingCarrier: orders.trackingCarrier,
      })
      .from(orders)
      .where(eq(orders.orderId, orderId))
      .limit(1);
    if (!order) {
      res.status(404).json({ success: false, error: `Bestellung ${orderId} nicht gefunden` });
      return;
    }

    if (order.trackingCarrier === "DHL" || order.trackingCarrier === "DHL_PENDING") {
      const lifecycle = (await getDhlLabelLifecycleForOrders([orderId])).get(orderId) ?? null;
      if (!isDhlLabelLifecycleUsable(lifecycle)) {
        res.status(409).json({ success: false, code: "LABEL_NOT_ACTIVE", state: lifecycle?.state,
          error: "Dieses Label ist storniert oder sein DHL-Zustand nicht sicher. Alte PDFs nur über die gekennzeichnete Labelhistorie öffnen." });
        return;
      }
    }

    const storedData = order.shippingLabelContent
      ? `data:application/pdf;base64,${order.shippingLabelContent}`
      : order.shippingLabelUrl;
    const match = typeof storedData === "string" ? storedData.match(/^data:([^;,]+);base64,(.+)$/s) : null;
    if (!match) {
      res.status(404).json({ success: false, error: "Kein gespeichertes Label für diese Bestellung vorhanden" });
      return;
    }

    const [, contentType, base64] = match;
    const buffer = Buffer.from(base64, "base64");
    const extension = contentType === "application/pdf" ? "pdf" : contentType.startsWith("image/") ? contentType.slice(6) : "bin";
    const carrier = (order.trackingCarrier || "Versand").replace(/[^a-z0-9_-]/gi, "-");
    res.set({
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${carrier}-label-${orderId}.${extension}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, no-cache",
    });
    res.send(buffer);
  },
);

// ─── GET /api/shipping/dhl/label/:orderId ─────────────────────────────────────
// Liest shippingLabelContent aus DB, decoded Base64 → Buffer → PDF-Response.
// Kein DHL-Call. Idempotent.

dhlExpressRouter.get(
  "/api/shipping/dhl/label/:orderId",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "");

    if (!orderId || orderId.trim() === "") {
      res.status(400).json({ success: false, error: "orderId fehlt" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ success: false, error: "Datenbank nicht verfügbar" });
      return;
    }

    const [order] = await db
      .select({
        orderId:              orders.orderId,
        shippingLabelContent: (orders as any).shippingLabelContent,
        trackingNumber:       orders.trackingNumber,
      })
      .from(orders)
      .where(eq(orders.orderId, orderId.trim()))
      .limit(1);

    if (!order) {
      res.status(404).json({ success: false, error: `Bestellung ${orderId} nicht gefunden` });
      return;
    }

    if (!order.shippingLabelContent) {
      res.status(404).json({
        success: false,
        error:   "Kein Label für diese Bestellung gespeichert",
        orderId: order.orderId,
      });
      return;
    }

    const lifecycle = (await getDhlLabelLifecycleForOrders([orderId.trim()])).get(orderId.trim()) ?? null;
    if (!isDhlLabelLifecycleUsable(lifecycle)) {
      res.status(409).json({ success: false, code: "LABEL_NOT_ACTIVE", state: lifecycle?.state,
        error: "Dieses Label ist nicht als aktives Versandlabel freigegeben. Archivierte PDFs stehen separat in der Labelhistorie." });
      return;
    }

    // Base64 → Buffer → PDF
    const pdfBuffer = Buffer.from(order.shippingLabelContent as string, "base64");

    res.set({
      "Content-Type":        "application/pdf",
      "Content-Disposition": `inline; filename="dhl-label-${orderId}.pdf"`,
      "Content-Length":      String(pdfBuffer.length),
      "Cache-Control":       "private, no-cache",
    });
    res.send(pdfBuffer);
  }
);

// Normal create and explicit relabel operations share the durable per-order guard.
const dhlOperations = new DhlRelabelService(new PgDhlLabelStore(), {
 prepare: prepareDhlLabel, create: requestDhlLabel, documents: buildDhlLabelDocuments, cancel: cancelDhlShipment,
});
for (const [path, kind] of [["create-label","create"],["cancel-label","cancel"],["attest-cancellation","attest"],["replace-label","replace"]] as const) {
 dhlExpressRouter.post(`/api/shipping/dhl/${path}`,requireWawiAdmin,async(req:Request,res:Response)=>{
  try {
   const user = await getUserFromRequest(req);
   const result = await dhlOperations.execute(kind, req.body, `${user?.id ?? "admin"}:${user?.username ?? user?.name ?? "admin"}`);
   res.status(result.httpStatus).json(result.body);
  } catch(error) { sendDhlOperationError(res,error); }
 });
}
dhlExpressRouter.get("/api/shipping/dhl/label-history/:orderId",requireWawiAdmin,async(req:Request,res:Response)=>{
 try { res.json(await dhlOperations.history(String(req.params.orderId))); } catch(error) { sendDhlOperationError(res,error); }
});
for (const [path, document] of [["label-generation","label"],["label-generation-documents","invoice"]] as const) {
 dhlExpressRouter.get(`/api/shipping/dhl/${path}/:orderId/:generationId`,requireWawiAdmin,async(req:Request,res:Response)=>{
  try {
   const content = await dhlOperations.document(String(req.params.orderId),String(req.params.generationId),document);
   const buffer = Buffer.from(content,"base64");
   res.set({"Content-Type":"application/pdf","Content-Disposition":`inline; filename="dhl-${document}.pdf"`,"Content-Length":String(buffer.length),"Cache-Control":"private, no-cache"});
   res.send(buffer);
  } catch(error) { sendDhlOperationError(res,error); }
 });
}
function sendDhlOperationError(res:Response,error:unknown) {
 if(error instanceof DhlLabelError) {res.status(error.status).json({success:false,error:error.message,code:error.code});return;}
 console.error("[dhlRouter] DHL operation failed; no blind retry",error);
 res.status(503).json({success:false,error:"DHL-Vorgang konnte nicht sicher abgeschlossen werden. Historie prüfen; kein zweites Label auslösen.",code:"DATABASE_UNAVAILABLE"});
}

// ─── POST /api/shipping/dhl/sandbox-test ─────────────────────────────────────
/**
 * Testet eine Billing Number gegen den DHL Sandbox-Endpoint.
 * KEIN DB-Write, KEIN Label speichern, KEIN Production-Call.
 * Immer Sandbox – unabhängig von DHL_SANDBOX ENV.
 *
 * Body: { billingNumber: string, product: string }
 *
 * Beispiel curl:
 *   curl -X POST https://<host>/api/shipping/dhl/sandbox-test \
 *     -H "Authorization: Bearer <jwt>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"billingNumber":"63979135286201","product":"V62WP"}'
 */
dhlExpressRouter.post(
  "/api/shipping/dhl/sandbox-test",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const { billingNumber, product } = req.body as {
      billingNumber?: string;
      product?: string;
    };

    if (!billingNumber || !product) {
      res.status(400).json({
        success: false,
        error: "billingNumber und product sind Pflichtfelder",
      });
      return;
    }

    const apiKey   = ENV.dhlApiKey;
    const username = ENV.dhlBusinessUsername;
    const password = ENV.dhlBusinessPassword;

    if (!apiKey || !username || !password) {
      res.status(500).json({ success: false, error: "DHL-Credentials nicht konfiguriert" });
      return;
    }

    const basicToken = Buffer.from(`${username}:${password}`).toString("base64");
    // Immer Sandbox – unabhängig von ENV.dhlSandbox
    const sandboxUrl =
      "https://api-sandbox.dhl.com/parcel/de/shipping/v2/orders?validate=false&mustEncode=false&printFormat=PDF&docFormat=PDF";

    // Minimaler Test-Payload mit Dummy-Adresse (DE national)
    const testPayload = {
      profile: "STANDARD_GRUPPENPROFIL",
      shipments: [
        {
          product:       product,
          billingNumber: billingNumber,
          refNo:         "SANDBOX-TEST-001",
          shipper: {
            name1:         "Core Versand und Logistik",
            addressStreet: "Klingenhagen",
            addressHouse:  "31",
            postalCode:    "48336",
            city:          "Sassenberg",
            country:       "DEU",
            email:         "versand@369research.eu",
          },
          consignee: {
            name1:         "Test Empfaenger",
            addressStreet: "Musterstrasse",
            addressHouse:  "1",
            postalCode:    "10115",
            city:          "Berlin",
            country:       "DEU",
            phone:         "+4915510000000",
          },
          details: {
            weight: { uom: "kg", value: 0.5 },
          },
        },
      ],
    };

    console.log(
      `[dhlSandboxTest] Teste billingNumber=${billingNumber} / product=${product} gegen DHL Sandbox`
    );

    try {
      const response = await fetch(sandboxUrl, {
        method: "POST",
        headers: {
          "dhl-api-key":   apiKey,
          "Authorization": `Basic ${basicToken}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify(testPayload),
      });

      const responseText = await response.text();
      let responseJson: unknown;
      try {
        responseJson = JSON.parse(responseText);
      } catch {
        responseJson = responseText;
      }

      console.log(
        `[dhlSandboxTest] HTTP ${response.status} | billingNumber=${billingNumber} | product=${product}`,
        responseJson
      );

      res.status(200).json({
        success:     response.ok,
        httpStatus:  response.status,
        billingNumber,
        product,
        dhlResponse: responseJson,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[dhlSandboxTest] Fetch-Fehler:", message);
      res.status(500).json({ success: false, error: message });
    }
  }
);
