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
import { createDhlShipmentDE, validateConsignee, type DhlConsignee } from "./dhlService.js";
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
    const { orderId, weightGrams } = req.body as {
      orderId?:     string;
      weightGrams?: number;
    };

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
    const consignee: DhlConsignee = {
      name1:         `${order.firstName} ${order.lastName}`.trim(),
      addressStreet: order.street,
      addressHouse:  order.houseNumber,
      postalCode:    order.zip,
      city:          order.city,
      country:       order.country,
      email:         order.email ?? undefined,
      phone:         order.phone ?? undefined,
    };

    // Firmenname als name1 wenn vorhanden
    if (order.company?.trim()) {
      consignee.name1 = order.company.trim();
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
    console.log(`[dhlRouter] Erstelle DHL-Label für Bestellung ${orderId} (Sandbox: ${ENV.dhlSandbox})`);

    const result = await createDhlShipmentDE({
      orderId:     orderId.trim(),
      consignee,
      weightGrams: weightGrams ?? undefined,
    });

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
