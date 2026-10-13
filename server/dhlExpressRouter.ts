/**
 * DHL Express Router
 *
 * Eigenständiger Express-Router für die DHL Geschäftskunden-Integration.
 * KEINE Änderungen an bestehenden Routen, Endpoints oder Datenmodellen.
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
 * Duplikat-Schutz (persistent, server-restart-sicher):
 *   Stufe 1: DB-Prüfung vor dem Call (trackingNumber IS NULL AND shippingLabelUrl IS NULL)
 *   Stufe 2: Atomares UPDATE mit WHERE-Bedingung (Race-Condition-Schutz auf DB-Ebene)
 *   Stufe 3: Kein blindes Überschreiben nach dem DHL-Call
 *
 * Sicherheit:
 *   - Nur eingeloggte Admin-User dürfen Labels erstellen und abrufen (JWT via getUserFromRequest)
 *   - Keine DHL-Credentials im Response
 */

import { Router, type Request, type Response } from "express";
import { ENV } from "./env.js";
import { createDhlShipmentCH, createDhlShipmentDE, createDhlShipmentEU, validateConsignee, normalizeCountryToAlpha3, type DhlConsignee } from "./dhlService.js";
import { getDhlProfiles, getActiveProfile, suggestProfile, type DhlProfileKey } from "./dhlProfiles.js";
import { getDb, getPool } from "./db.js";
import { orderItems, orders } from "../drizzle/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { getUserFromRequest } from "./auth.js";
import { buildSwissCommercialInvoicePdf, buildSwissCustomsDocumentsPdf, buildSwissThermalLabelPackagePdf, validateSwissCustomsDeclaration, type SwissCommercialInvoice, type SwissCustomsDeclaration, type ValidatedSwissCustomsDeclaration } from "./swissCustomsService.js";

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

type SwissCustomsDraftItem = {
  orderItemId: number;
  description: string;
  hsCode: string;
  countryOfOrigin: string;
  unitWeightGrams: number;
  unitCustomsValueEur: number;
};

function isSwissDestination(country: string | null | undefined): boolean {
  return normalizeCountryToAlpha3(String(country ?? "")) === "CHE";
}

async function loadSwissCustomsForLabel(order: typeof orders.$inferSelect): Promise<{
  declaration: ValidatedSwissCustomsDeclaration;
  invoice: SwissCommercialInvoice;
}> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank für Schweizer Zolldaten nicht verfügbar");
  const result = await pool.query(`
    SELECT
      declaration.package_weight_grams,
      declaration.invoice_number,
      declaration.created_at,
      declaration.compliance_confirmed_at,
      item.order_item_id,
      item.item_description,
      item.hs_code,
      item.country_of_origin,
      item.unit_weight_grams,
      item.unit_customs_value_eur,
      order_item.quantity
    FROM order_swiss_customs_declarations declaration
    JOIN order_swiss_customs_items item ON item.declaration_id = declaration.id
    JOIN order_items order_item ON order_item.id = item.order_item_id
    WHERE declaration.order_id = $1
    ORDER BY order_item.id ASC
  `, [order.orderId]);
  if (result.rows.length === 0) {
    throw new Error("Für diese Schweizer Bestellung fehlen gespeicherte Zolldaten.");
  }
  const first = result.rows[0];
  if (!first.compliance_confirmed_at) {
    throw new Error("Die Compliance-Prüfung für diese Schweizer Sendung wurde nicht bestätigt.");
  }
  const declaration: SwissCustomsDeclaration = {
    orderId: order.orderId,
    packageWeightGrams: Number(first.package_weight_grams),
    shippingEur: Number(order.shipping ?? 0),
    subtotalEur: Number(order.subtotal ?? 0),
    discountEur: Number(order.discount ?? 0),
    lines: result.rows.map((row) => ({
      orderItemId: Number(row.order_item_id),
      description: row.item_description,
      hsCode: row.hs_code,
      countryOfOrigin: row.country_of_origin,
      unitWeightGrams: Number(row.unit_weight_grams),
      quantity: Number(row.quantity),
      unitCustomsValueEur: Number(row.unit_customs_value_eur),
    })),
  };
  const validated = validateSwissCustomsDeclaration(declaration);
  if (!validated.ok) throw new Error(validated.error);
  if (validated.value.goodsValueEur > 1000) {
    throw new Error("Warenwert über 1.000 €: Ausfuhrbegleitdokument (ABD) ist zusätzlich erforderlich und wird nicht automatisch erzeugt.");
  }
  return {
    declaration: validated.value,
    invoice: {
      invoiceNumber: String(first.invoice_number),
      invoiceDate: new Date(first.created_at),
      seller: {
        name: "369 RESEARCH Sp. z o.o.",
        street: "Hoża 86/210",
        zip: "00-682",
        city: "Warszawa",
        country: "Poland",
        taxId: "PL5214161163",
      },
      consignee: {
        name: `${order.firstName ?? ""} ${order.lastName ?? ""}`.trim(),
        street: String(order.street ?? ""),
        houseNumber: String(order.houseNumber ?? ""),
        zip: String(order.zip ?? ""),
        city: String(order.city ?? ""),
        country: "Switzerland",
      },
      declaration: validated.value,
    },
  };
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
    res.json({
      success: true,
      orderId,
      packageWeightGrams: declaration?.package_weight_grams ? Number(declaration.package_weight_grams) : null,
      complianceConfirmed: Boolean(declaration?.compliance_confirmed_at),
      items: rows.map((item) => {
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
    const body = req.body as { packageWeightGrams?: unknown; complianceConfirmed?: unknown; items?: SwissCustomsDraftItem[] };
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
    if (!Array.isArray(body.items) || body.items.length !== existingItems.length) {
      res.status(422).json({ success: false, error: "Alle Bestellpositionen müssen genau einmal mit Zolldaten erfasst werden." });
      return;
    }
    const inputById = new Map(body.items.map((item) => [Number(item.orderItemId), item]));
    if (inputById.size !== existingItems.length || existingItems.some((item) => !inputById.has(item.id))) {
      res.status(422).json({ success: false, error: "Die Zolldaten passen nicht exakt zu den Bestellpositionen." });
      return;
    }
    const draft: SwissCustomsDeclaration = {
      orderId,
      packageWeightGrams: Number(body.packageWeightGrams),
      shippingEur: Number(order.shipping ?? 0),
      subtotalEur: Number(order.subtotal ?? 0),
      discountEur: Number(order.discount ?? 0),
      lines: existingItems.map((item) => {
        const customs = inputById.get(item.id)!;
        return {
          orderItemId: item.id,
          description: customs.description,
          hsCode: customs.hsCode,
          countryOfOrigin: customs.countryOfOrigin,
          unitWeightGrams: Number(customs.unitWeightGrams),
          quantity: Number(item.quantity),
          unitCustomsValueEur: Number(customs.unitCustomsValueEur),
        };
      }),
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

// ─── POST /api/shipping/dhl/create-label ──────────────────────────────────────
// Erstellt ein DHL-Label für eine bestehende Bestellung.
// Schreibt in: trackingNumber, trackingCarrier, shippingLabelUrl, shippingLabelContent

dhlExpressRouter.post(
  "/api/shipping/dhl/create-label",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const { orderId, weightGrams, shippingProfile } = req.body as {
      orderId?:        string;
      weightGrams?:    number;
      shippingProfile?: string;
    };
    // ── Profil-Auswahl (Default: DHL_DE_STANDARD) ────────────────────────────
    const profileKey: DhlProfileKey = (shippingProfile as DhlProfileKey) ?? "DHL_DE_STANDARD";
    const allProfiles = getDhlProfiles();
    if (!allProfiles[profileKey]) {
      res.status(400).json({ success: false, error: `Unbekanntes Versandprofil: ${profileKey}` });
      return;
    }
    let activeProfile;
    try {
      activeProfile = getActiveProfile(profileKey);
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }

    // ── Eingabe-Validierung ──────────────────────────────────────────────────
    if (!orderId || typeof orderId !== "string" || orderId.trim() === "") {
      res.status(400).json({ success: false, error: "orderId fehlt oder ungültig" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ success: false, error: "Datenbank nicht verfügbar" });
      return;
    }

    // ── Stufe 1: Bestellung laden und Duplikat-Prüfung ───────────────────────
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.orderId, orderId.trim()))
      .limit(1);

    if (!order) {
      res.status(404).json({ success: false, error: `Bestellung ${orderId} nicht gefunden` });
      return;
    }

    if (order.trackingNumber || order.shippingLabelUrl) {
      res.status(409).json({
        success: false,
        error:   "Bestellung hat bereits ein Label oder eine Trackingnummer – kein neues Label erstellt",
        existing: {
          trackingNumber: order.trackingNumber ?? null,
          labelUrl:       order.shippingLabelUrl ?? null,
        },
      });
      return;
    }

    // Das gewählte Vertragsprodukt darf nur für sein tatsächlich hinterlegtes
    // Zielland und innerhalb der serverseitigen Gewichtsgrenze verwendet werden.
    // Die Prüfung bleibt bewusst im Backend, damit sie nicht über einen direkten
    // API-Aufruf oder eine veraltete Browseransicht umgangen werden kann.
    const rawDestinationCountry = String(order.country ?? (order as any).shippingCountry ?? "").trim();
    const destinationCountry = alpha3ToAlpha2[normalizeCountryToAlpha3(rawDestinationCountry)] ?? rawDestinationCountry.toUpperCase();
    if (!activeProfile.countries.includes(destinationCountry)) {
      res.status(422).json({
        success: false,
        error: `Versandprofil \"${activeProfile.label}\" ist für das Zielland ${destinationCountry || "ohne Länderangabe"} nicht zulässig.`,
      });
      return;
    }

    // Ein fehlender Gewichtsdatensatz darf niemals das Profil-Maximum als Sendungsgewicht
    // an DHL übergeben. Bei CH ist ausschließlich das zuvor gespeicherte, tatsächliche
    // Paketgewicht zulässig; Browserwerte werden bewusst nicht akzeptiert.
    let swissCustoms: { declaration: ValidatedSwissCustomsDeclaration; invoice: SwissCommercialInvoice } | null = null;
    if (profileKey === "DHL_CH") {
      try {
        swissCustoms = await loadSwissCustomsForLabel(order);
      } catch (error: any) {
        res.status(422).json({ success: false, error: error.message || "Schweizer Zolldaten sind unvollständig." });
        return;
      }
    }
    const requestedWeightG = profileKey === "DHL_CH"
      ? swissCustoms!.declaration.packageWeightGrams
      : Number(weightGrams ?? (order as any).weightGrams ?? 1000);
    if (!Number.isFinite(requestedWeightG) || requestedWeightG <= 0) {
      res.status(422).json({ success: false, error: "Gewicht für die DHL-Sendung fehlt oder ist ungültig." });
      return;
    }
    if (requestedWeightG > activeProfile.maxWeightG) {
      res.status(422).json({
        success: false,
        error: `${activeProfile.label} erlaubt maximal ${activeProfile.maxWeightG} g; angegeben sind ${requestedWeightG} g. Bitte DHL Paket Standard wählen.`,
      });
      return;
    }

    // ── Adress-Validierung vor DHL-Call ──────────────────────────────────────
    // Normalisiere Land: "Deutschland", "Germany", "DEU", "de" → "DE"
    const normalizeCountry = (raw: string | null | undefined): string => {
      if (!raw) return "";
      const s = raw.trim().toUpperCase();
      if (s === "DEUTSCHLAND" || s === "GERMANY" || s === "DEU" || s === "DE") return "DE";
      return raw.trim();
    };
    // ── DHL-Abholort-Erkennung ────────────────────────────────────────────────
    // Prüft delivery_type aus DB ODER erkennt "Packstation" im street-Feld (Fallback)
    // Drei Erkennungswege (OR-Logik, alle idempotent):
    // 1. delivery_type = "packstation" (gesetzt beim Checkout)
    // 2. street-Feld enthaelt "Packstation" (manuell eingetragen oder aeltere Bestellungen)
    // 3. dhlPostNumber vorhanden + street leer (WaWi-Kunden mit Packstation-Nr. in houseNumber)
    const dhlPostNumberRaw = ((order as any).dhlPostNumber ?? "").trim();
    const isPackstation =
      (order as any).deliveryType === "packstation" ||
      /^packstation\b/i.test((order.street ?? "").trim()) ||
      (!!dhlPostNumberRaw && !(order.street ?? "").trim());
    const isPostfiliale =
      (order as any).deliveryType === "postfiliale" ||
      /^postfiliale\b/i.test((order.street ?? "").trim());

    const consignee: DhlConsignee = {
      name1:         `${order.firstName} ${order.lastName}`.trim(),
      addressStreet: order.street,
      addressHouse:  order.houseNumber,
      postalCode:    (order.zip ?? "").trim(), // trim() verhindert DHL-Fehler bei PLZ mit Leerzeichen
      city:          order.city,
      // DE: normalisiert auf "DE"; EU: Rohwert – normalizeCountryToAlpha3 läuft in createDhlShipmentEU
      country:       profileKey === "DHL_DE_STANDARD" ? normalizeCountry(order.country) : (order.country ?? ""),
      email:         order.email ?? undefined,
      phone:         order.phone ?? undefined,
    };

    if (profileKey === "DHL_DE_ECONOMY" && (isPackstation || isPostfiliale)) {
      res.status(422).json({
        success: false,
        error: "DHL Kleinpaket ist nicht für Packstation- oder Postfilial-Adressen zulässig. Bitte DHL Paket Standard wählen.",
      });
      return;
    }

    if (isPackstation || isPostfiliale) {
      // DHL-Abholort-Adressformat:
      //   name1 = Kundenname
      //   name2 = DHL-Postnummer (Pflichtfeld)
      //   addressStreet = "Packstation" oder "Postfiliale"
      //   addressHouse  = Standortnummer
      const dhlPostNumber = dhlPostNumberRaw; // bereits oben aus order gelesen
      if (!dhlPostNumber) {
        // Sicherheitsnetz: Wenn keine Postnummer hinterlegt, Label-Erstellung blockieren
        res.status(422).json({
          success: false,
          error: `${isPostfiliale ? "Postfilial" : "Packstation"}-Lieferung: DHL-Postnummer fehlt. Bitte Bestellung manuell prüfen.`,
        });
        return;
      }
      const pickupLocationLabel = isPostfiliale ? "Postfiliale" : "Packstation";
      consignee.addressStreet = pickupLocationLabel;
      // Standortnummer: aus houseNumber ODER aus street-Feld parsen.
      let pickupLocationNr = (order.houseNumber ?? "").trim();
      if (!pickupLocationNr) {
        // Fallback: street-Feld parsen → "Packstation 135 118" → erster Token nach "Packstation" ist die Nr.
        const streetParts = (order.street ?? "").trim().split(/\s+/);
        if (streetParts.length >= 2) pickupLocationNr = streetParts[1];
      }
      consignee.addressHouse = pickupLocationNr || "";
      // name2 = Postnummer (DHL-Pflichtfeld)
      consignee.name2 = dhlPostNumber.slice(0, 20);
      console.log(`[dhlRouter] ${pickupLocationLabel}-Lieferung: ${pickupLocationLabel} ${pickupLocationNr}, Post-Nr. ${dhlPostNumber}`);
    } else if (order.company?.trim()) {
      // Firmenname als name1 wenn vorhanden, Personenname dann in name2
      const fullName = `${order.firstName} ${order.lastName}`.trim();
      consignee.name1 = order.company.trim().slice(0, 50);
      if (fullName) consignee.name2 = fullName.slice(0, 50);
    }

    const validationError = validateConsignee(consignee);
    if (validationError) {
      res.status(422).json({ success: false, error: validationError });
      return;
    }

    // ── Stufe 2: Atomares UPDATE als Race-Condition-Schutz ───────────────────
    // Setzt trackingCarrier auf "DHL_PENDING" nur wenn noch kein Tracking vorhanden.
    const lockResult = await db
      .update(orders)
      .set({ trackingCarrier: "DHL_PENDING" })
      .where(
        and(
          eq(orders.orderId, orderId.trim()),
          isNull(orders.trackingNumber),
          isNull(orders.shippingLabelUrl),
          isNull(orders.trackingCarrier)
        )
      );

    const rowsUpdated = (lockResult as any)?.rowCount ?? (lockResult as any)?.rowsAffected ?? 1;
    if (rowsUpdated === 0) {
      res.status(409).json({
        success: false,
        error:   "Label-Erstellung bereits in Bearbeitung oder Duplikat erkannt",
      });
      return;
    }

        // ── DHL-Call ─────────────────────────────────────────────────────────────
    console.log(`[dhlRouter] Erstelle DHL-Label für Bestellung ${orderId} | Profil: ${profileKey} | Produkt: ${activeProfile.product} | Sandbox: ${ENV.dhlSandbox}`);
    const shipmentInput = {
      orderId:       orderId.trim(),
      consignee,
      weightGrams:   requestedWeightG,
      productCode:   activeProfile.product,
      billingNumber: activeProfile.billingNumber!,
      ...(swissCustoms ? { swissCustoms: swissCustoms.declaration } : {}),
    };
    // DHL_DE_STANDARD → createDhlShipmentDE (unverändert)
    // DHL_EU          → createDhlShipmentEU (Phase 2, V53WPAK)
    // DHL_CH          → V53WPAK mit DAP und vollständigen Zoll-EDI-Daten
    const result = profileKey === "DHL_CH"
      ? await createDhlShipmentCH(shipmentInput)
      : profileKey === "DHL_EU"
        ? await createDhlShipmentEU(shipmentInput)
        : await createDhlShipmentDE(shipmentInput);

    // ── Stufe 3: Ergebnis in DB schreiben ────────────────────────────────────
    if (result.success && result.trackingNumber) {
      // Interne Download-Route als shippingLabelUrl
      const labelRoute = `/api/shipping/dhl/label/${orderId.trim()}`;

      // Schweiz: Das gespeicherte Versandlabel ist bewusst ein dreiseitiges
      // 100×150-mm-Thermopaket: DHL-Marke + linke/rechte DHL-CN23-Hälfte.
      // Die A4-Handelsrechnungen bleiben zusätzlich unverändert gespeichert.
      let labelContent = result.labelBase64 ?? null;
      const customsDocContent = result.customsDocBase64 ?? null;
      let commercialInvoiceContent: string | null = null;
      let customsPrintContent: string | null = null;
      if (profileKey === "DHL_CH") {
        try {
          if (!labelContent || !customsDocContent || !swissCustoms) throw new Error(result.error || "DHL-Label, CN23 oder Zolldaten fehlen");
          const commercialInvoice = await buildSwissCommercialInvoicePdf({
            invoice: swissCustoms.invoice,
          });
          commercialInvoiceContent = Buffer.from(commercialInvoice).toString("base64");
          const customsPrintPackage = await buildSwissCustomsDocumentsPdf({
            customsDocPdfBase64: customsDocContent,
            invoice: swissCustoms.invoice,
          });
          customsPrintContent = Buffer.from(customsPrintPackage).toString("base64");
          const thermalLabelPackage = await buildSwissThermalLabelPackagePdf({
            shippingLabelPdfBase64: labelContent,
            customsDocPdfBase64: customsDocContent,
          });
          labelContent = Buffer.from(thermalLabelPackage).toString("base64");
        } catch (error: any) {
          // Das DHL-Label wurde extern bereits gebucht. Ohne eine gespeicherte
          // vollständige Zollmappe darf keine scheinbar vollständige Schweiz-Sendung
          // erscheinen; der Pending-Lock verhindert ein zweites Label.
          console.error(`[dhlRouter/CH] Schweizer Druckpaket konnte nicht erzeugt werden:`, error);
          res.status(500).json({ success: false, error: "DHL-Label erstellt, aber das Schweizer Druckpaket konnte nicht vollständig erzeugt und abgelegt werden. Bitte Support kontaktieren; kein zweites Label auslösen." });
          return;
        }
      }

      if (profileKey === "DHL_CH" && commercialInvoiceContent) {
        const pool = await getPool();
        if (!pool) {
          console.error(`[dhlRouter/CH] Handelsrechnung für ${orderId} konnte nicht gespeichert werden: Datenbank nicht verfügbar`);
          res.status(500).json({ success: false, error: "DHL-Label erstellt, aber die Handelsrechnung konnte nicht gespeichert werden. Bitte Support kontaktieren; kein zweites Label auslösen." });
          return;
        }
        const invoiceStored = await pool.query(`
          UPDATE order_swiss_customs_declarations
          SET commercial_invoice_content = $1,
              commercial_invoice_generated_at = NOW(),
              customs_print_content = $2,
              customs_print_generated_at = NOW(),
              updated_at = NOW()
          WHERE order_id = $3
        `, [commercialInvoiceContent, customsPrintContent, orderId.trim()]);
        if ((invoiceStored.rowCount ?? 0) !== 1) {
          console.error(`[dhlRouter/CH] Handelsrechnung für ${orderId} konnte nicht zugeordnet werden`);
          res.status(500).json({ success: false, error: "DHL-Label erstellt, aber die Zollunterlagen konnten nicht der Bestellung zugeordnet werden. Bitte Support kontaktieren; kein zweites Label auslösen." });
          return;
        }
      }

      await db
        .update(orders)
        .set({
          trackingNumber:   result.trackingNumber,
          trackingCarrier:  "DHL",
          shippingLabelUrl: labelRoute,
          ...(labelContent ? { shippingLabelContent: labelContent } as any : {}),
        })
        .where(eq(orders.orderId, orderId.trim()));

      console.log(`[dhlRouter] Schweizer Unterlagen gespeichert: ${result.trackingNumber} | 3× 4×6 (Label + CN23-Hälften), Handelsrechnung A4 | Customs: ${customsPrintContent ? 'ja' : 'nein'}`);

      res.json({
        success:        true,
        trackingNumber: result.trackingNumber,
        labelUrl:       labelRoute,
        hasContent:     !!labelContent,
        customsInvoiceStored: profileKey === "DHL_CH" && !!commercialInvoiceContent && !!customsDocContent,
        sandbox:        ENV.dhlSandbox,
      });
    } else {
      // Fehlerfall: Lock-Marker zurücksetzen
      await db
        .update(orders)
        .set({ trackingCarrier: null })
        .where(
          and(
            eq(orders.orderId, orderId.trim()),
            isNull(orders.trackingNumber)
          )
        );

      console.error(`[dhlRouter] DHL-Fehler für ${orderId}:`, result.error);

      res.status(502).json({
        success: false,
        error:   result.error ?? "Unbekannter DHL-Fehler",
        statusCode: result.statusCode ?? null,
      });
    }
  }
);

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
