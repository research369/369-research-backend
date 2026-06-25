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
import { createDhlShipmentDE, createDhlShipmentEU, validateConsignee, normalizeCountryToAlpha3, type DhlConsignee } from "./dhlService.js";
import { getDhlProfiles, getActiveProfile, type DhlProfileKey } from "./dhlProfiles.js";
import { getDb } from "./db.js";
import { orders } from "../drizzle/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { getUserFromRequest } from "./auth.js";

export const dhlExpressRouter = Router();

// ─── Middleware: JWT-Auth für Label-Erstellung und -Abruf ────────────────────

async function requireWawiAdmin(
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

    // ── Adress-Validierung vor DHL-Call ──────────────────────────────────────
    // Normalisiere Land: "Deutschland", "Germany", "DEU", "de" → "DE"
    const normalizeCountry = (raw: string | null | undefined): string => {
      if (!raw) return "";
      const s = raw.trim().toUpperCase();
      if (s === "DEUTSCHLAND" || s === "GERMANY" || s === "DEU" || s === "DE") return "DE";
      return raw.trim();
    };
    // ── Packstation-Erkennung ────────────────────────────────────────────────
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

    const consignee: DhlConsignee = {
      name1:         `${order.firstName} ${order.lastName}`.trim(),
      addressStreet: order.street,
      addressHouse:  order.houseNumber,
      postalCode:    order.zip,
      city:          order.city,
      // DE: normalisiert auf "DE"; EU: Rohwert – normalizeCountryToAlpha3 läuft in createDhlShipmentEU
      country:       profileKey === "DHL_DE_STANDARD" ? normalizeCountry(order.country) : (order.country ?? ""),
      email:         order.email ?? undefined,
      phone:         order.phone ?? undefined,
    };

    if (isPackstation) {
      // DHL Packstation-Adressformat:
      //   name1 = Kundenname
      //   name2 = DHL-Postnummer (Pflichtfeld für Packstation-Zustellung)
      //   addressStreet = "Packstation"
      //   addressHouse  = Packstation-Nummer (z.B. "123")
      const dhlPostNumber = dhlPostNumberRaw; // bereits oben aus order gelesen
      if (!dhlPostNumber) {
        // Sicherheitsnetz: Wenn keine Postnummer hinterlegt, Label-Erstellung blockieren
        res.status(422).json({
          success: false,
          error: "Packstation-Lieferung: DHL-Postnummer fehlt. Bitte Bestellung manuell prüfen.",
        });
        return;
      }
      consignee.addressStreet = "Packstation";
      // Packstation-Nummer: aus houseNumber ODER aus street-Feld parsen (z.B. "Packstation 135 118" → "135")
      let packstationNr = (order.houseNumber ?? "").trim();
      if (!packstationNr) {
        // Fallback: street-Feld parsen → "Packstation 135 118" → erster Token nach "Packstation" ist die Nr.
        const streetParts = (order.street ?? "").trim().split(/\s+/);
        // streetParts[0] = "Packstation", streetParts[1] = Packstation-Nr., streetParts[2] = ggf. Zusatz
        if (streetParts.length >= 2) packstationNr = streetParts[1];
      }
      consignee.addressHouse = packstationNr || "";
      // name2 = Postnummer (DHL-Pflichtfeld)
      consignee.name2 = dhlPostNumber.slice(0, 20);
      console.log(`[dhlRouter] Packstation-Lieferung: Packstation ${packstationNr}, Post-Nr. ${dhlPostNumber}`);
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
          isNull(orders.shippingLabelUrl)
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
      weightGrams:   weightGrams ?? undefined,
      productCode:   activeProfile.product,
      billingNumber: activeProfile.billingNumber!,
    };
    // DHL_DE_STANDARD → createDhlShipmentDE (unverändert)
    // DHL_EU          → createDhlShipmentEU (Phase 2, V53WPAK)
    const result = profileKey === "DHL_EU"
      ? await createDhlShipmentEU(shipmentInput)
      : await createDhlShipmentDE(shipmentInput);

    // ── Stufe 3: Ergebnis in DB schreiben ────────────────────────────────────
    if (result.success && result.trackingNumber) {
      // Interne Download-Route als shippingLabelUrl
      const labelRoute = `/api/shipping/dhl/label/${orderId.trim()}`;

      // Base64-PDF in shippingLabelContent speichern
      const labelContent = result.labelBase64 ?? null;

      await db
        .update(orders)
        .set({
          trackingNumber:   result.trackingNumber,
          trackingCarrier:  "DHL",
          shippingLabelUrl: labelRoute,
          ...(labelContent ? { shippingLabelContent: labelContent } as any : {}),
        })
        .where(eq(orders.orderId, orderId.trim()));

      console.log(`[dhlRouter] Label gespeichert: ${result.trackingNumber} | Route: ${labelRoute} | Content: ${labelContent ? 'ja' : 'nein'}`);

      res.json({
        success:        true,
        trackingNumber: result.trackingNumber,
        labelUrl:       labelRoute,
        hasContent:     !!labelContent,
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
