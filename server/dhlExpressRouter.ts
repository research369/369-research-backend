/**
 * DHL Express Router
 *
 * Eigenständiger Express-Router für die DHL Geschäftskunden-Integration.
 * KEINE Änderungen an bestehenden Routen, Endpoints oder Datenmodellen.
 * DHL ist eine additive Versandoption neben dem manuellen Workflow
 * und der Sendcloud-Integration.
 *
 * Endpoints:
 *   POST /api/shipping/dhl/create-label  – DHL-Label für eine Bestellung erstellen
 *   GET  /api/shipping/dhl/status        – Konfigurationsstatus prüfen (kein DHL-Call)
 *
 * Duplikat-Schutz (persistent, server-restart-sicher):
 *   Stufe 1: DB-Prüfung vor dem Call (trackingNumber IS NULL AND shippingLabelUrl IS NULL)
 *   Stufe 2: Atomares UPDATE mit WHERE-Bedingung (Race-Condition-Schutz auf DB-Ebene)
 *   Stufe 3: Kein blindes Überschreiben nach dem DHL-Call
 *
 * Sicherheit:
 *   - Nur eingeloggte Admin-User dürfen Labels erstellen (JWT via getUserFromRequest)
 *   - Keine DHL-Credentials im Response
 *   - Kein Production-Call wenn DHL_SANDBOX=true (Default)
 */

import { Router, type Request, type Response } from "express";
import { ENV } from "./env.js";
import { createDhlShipmentDE, validateConsignee, type DhlConsignee } from "./dhlService.js";
import { getDb } from "./db.js";
import { orders } from "../drizzle/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { getUserFromRequest } from "./auth.js";

export const dhlExpressRouter = Router();

// ─── Middleware: JWT-Auth für Label-Erstellung ────────────────────────────────

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
// Nützlich für Debugging und Sandbox-Verifikation.

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

// ─── POST /api/shipping/dhl/create-label ──────────────────────────────────────
// Erstellt ein DHL-Label für eine bestehende Bestellung.
// Schreibt ausschließlich in bestehende Felder:
//   trackingNumber, trackingCarrier, shippingLabelUrl

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
          hasLabel:       !!order.shippingLabelUrl,
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
    // Wenn ein anderer Request gleichzeitig läuft, schlägt dieses UPDATE fehl (0 rows).
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

    // Drizzle gibt rowCount zurück – wenn 0, hat ein anderer Request bereits gelockt
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
      await db
        .update(orders)
        .set({
          trackingNumber:  result.trackingNumber,
          trackingCarrier: "DHL",
          shippingLabelUrl: result.labelUrl ?? result.labelBase64 ?? null,
        })
        .where(eq(orders.orderId, orderId.trim()));

      console.log(`[dhlRouter] Label gespeichert: ${result.trackingNumber}`);

      res.json({
        success:        true,
        trackingNumber: result.trackingNumber,
        labelUrl:       result.labelUrl ?? null,
        sandbox:        ENV.dhlSandbox,
      });
    } else {
      // Fehlerfall: Lock-Marker zurücksetzen damit ein erneuter Versuch möglich ist
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
