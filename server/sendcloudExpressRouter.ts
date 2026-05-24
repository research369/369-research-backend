/**
 * Sendcloud Express Router
 *
 * Eigenständiger Express-Router für Sendcloud-Shipping-Integration.
 * KEINE Änderungen an bestehenden Routen, Endpoints oder Datenmodellen.
 * Sendcloud ist eine additive Shipping-Option neben dem manuellen Workflow.
 *
 * Endpoints:
 *   POST /api/shipping/sendcloud/create-label   – Label für eine Bestellung erstellen
 *   POST /api/webhooks/sendcloud                – Sendcloud Status-Webhooks empfangen
 *   GET  /api/shipping/sendcloud/methods        – Verfügbare Versandmethoden abrufen
 */

import { Router, type Request, type Response } from "express";
import { ENV } from "./env.js";
import {
  createSendcloudLabel,
  parseSendcloudWebhook,
  mapSendcloudStatus,
  verifySendcloudWebhook,
} from "./sendcloudService.js";
import { getDb } from "./db.js";
import { orders } from "../drizzle/schema.js";
import { eq } from "drizzle-orm";
import { getUserFromRequest } from "./auth.js";

export const sendcloudExpressRouter = Router();

// ─── Middleware: JWT-Auth für Label-Erstellung ────────────────────────────────
// Nutzt die bestehende WaWi-JWT-Auth (getUserFromRequest aus auth.ts).
// Nur eingeloggte Admin-User dürfen Labels erstellen.
// WAWI_INTERNAL_KEY bleibt nur für Server-to-Server-Calls.
async function requireWawiAdmin(
  req: Request,
  res: Response,
  next: () => void
): Promise<void> {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Nicht angemeldet" });
    return;
  }
  if (user.role !== "admin") {
    res.status(403).json({ error: "Keine Berechtigung – Admin erforderlich" });
    return;
  }
  next();
}

// ─── POST /api/shipping/sendcloud/create-label ───────────────────────────────
// Erstellt ein Sendcloud-Label für eine bestehende Bestellung.
// Schreibt nur in bestehende Felder: trackingNumber, trackingCarrier, shippingLabelUrl
sendcloudExpressRouter.post(
  "/api/shipping/sendcloud/create-label",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    try {
      const { orderId, weightKg } = req.body as {
        orderId?: string;
        weightKg?: number;
      };

      if (!orderId || typeof orderId !== "string") {
        res.status(400).json({ success: false, error: "orderId fehlt" });
        return;
      }

      const db = await getDb();
      if (!db) {
        res.status(503).json({ success: false, error: "Datenbank nicht verfügbar" });
        return;
      }

      // Bestellung laden
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, orderId))
        .limit(1);

      if (!order) {
        res.status(404).json({ success: false, error: "Bestellung nicht gefunden" });
        return;
      }

      // Kein Duplikat-Label
      if (order.trackingNumber) {
        res.status(409).json({
          success: false,
          error: `Label bereits vorhanden (Tracking: ${order.trackingNumber})`,
        });
        return;
      }

      // Sendcloud-Label erstellen
      const result = await createSendcloudLabel({
        orderId: order.orderId,
        firstName: order.firstName,
        lastName: order.lastName,
        company: order.company || undefined,
        street: order.street,
        houseNumber: order.houseNumber,
        city: order.city,
        zip: order.zip,
        country: order.country,
        email: order.email || undefined,
        phone: order.phone || undefined,
        weightKg: typeof weightKg === "number" ? weightKg : 2.0,
      });

      if (!result.success) {
        // Fehler in internalNote speichern (bestehendes optionales Feld)
        try {
          const errNote = `[Sendcloud ${new Date().toISOString()}] ${result.errorCode}: ${result.errorMessage}`;
          await db
            .update(orders)
            .set({
              internalNote: order.internalNote
                ? `${order.internalNote}\n${errNote}`
                : errNote,
            })
            .where(eq(orders.orderId, orderId));
        } catch {
          // Fehler beim Speichern ignorieren – Hauptfehler zurückgeben
        }
        res.status(422).json({
          success: false,
          errorCode: result.errorCode,
          error: result.errorMessage,
        });
        return;
      }

      // Tracking-Daten in bestehende Felder schreiben
      await db
        .update(orders)
        .set({
          trackingNumber: result.trackingNumber,
          trackingCarrier: "DHL",
          shippingLabelUrl: result.labelUrl || null,
        })
        .where(eq(orders.orderId, orderId));

      console.log(
        `[Sendcloud] Label erstellt: order=${orderId}, tracking=${result.trackingNumber}`
      );

      res.json({
        success: true,
        parcelId: result.parcelId,
        trackingNumber: result.trackingNumber,
        trackingUrl: result.trackingUrl,
        labelUrl: result.labelUrl,
      });
    } catch (err: any) {
      console.error("[Sendcloud] create-label Fehler:", err.message);
      res.status(500).json({ success: false, error: "Interner Fehler" });
    }
  }
);

// ─── GET /api/webhooks/sendcloud ─────────────────────────────────────────────
// Sendcloud schickt beim Speichern der Integration einen GET-Request zur Validierung
sendcloudExpressRouter.get(
  "/api/webhooks/sendcloud",
  (_req: Request, res: Response) => {
    res.status(200).json({ received: true, status: "ok" });
  }
);

// ─── POST /api/webhooks/sendcloud ────────────────────────────────────────────
// Empfängt Status-Updates von Sendcloud (kein Auth – Sendcloud ruft diesen Endpoint auf)
sendcloudExpressRouter.post(
  "/api/webhooks/sendcloud",
  async (req: Request, res: Response) => {
    // Sofort 200 antworten (Sendcloud erwartet schnelle Antwort)
    res.status(200).json({ received: true });

    try {
      // Optionale Signatur-Prüfung
      const signature = req.headers["sendcloud-signature"] as string | undefined;
      if (signature && ENV.sendcloudWebhookSecret) {
        const rawBody = JSON.stringify(req.body);
        const valid = verifySendcloudWebhook(rawBody, signature, ENV.sendcloudWebhookSecret);
        if (!valid) {
          console.warn("[Sendcloud Webhook] Ungültige Signatur – ignoriert");
          return;
        }
      }

      const payload = parseSendcloudWebhook(req.body);
      if (!payload) {
        console.warn("[Sendcloud Webhook] Ungültiger Payload");
        return;
      }

      const { action, parcel } = payload;
      const orderId = parcel?.order_number;
      const trackingNumber = parcel?.tracking_number;
      const statusId = parcel?.status?.id;

      console.log(
        `[Sendcloud Webhook] action=${action}, order=${orderId}, statusId=${statusId}`
      );

      if (!orderId) return;

      const db = await getDb();
      if (!db) return;

      const shippingStatus = mapSendcloudStatus(statusId || 0);
      const updateData: Record<string, unknown> = {};

      if (trackingNumber) {
        updateData.trackingNumber = trackingNumber;
        updateData.trackingCarrier = "DHL";
      }

      if (shippingStatus === "shipped" || shippingStatus === "label_created") {
        updateData.shippedAt = new Date();
      }

      if (shippingStatus === "delivered") {
        updateData.deliveredAt = new Date();
        updateData.status = "zugestellt";
      }

      if (Object.keys(updateData).length > 0) {
        await db
          .update(orders)
          .set(updateData)
          .where(eq(orders.orderId, orderId));
        console.log(
          `[Sendcloud Webhook] Order ${orderId} aktualisiert: ${JSON.stringify(updateData)}`
        );
      }
    } catch (err: any) {
      console.error("[Sendcloud Webhook] Verarbeitungsfehler:", err.message);
    }
  }
);

// ─── GET /api/shipping/sendcloud/methods ─────────────────────────────────────
// Gibt verfügbare Sendcloud-Versandmethoden zurück (für Frontend-Auswahl)
sendcloudExpressRouter.get(
  "/api/shipping/sendcloud/methods",
  requireWawiAdmin,
  async (_req: Request, res: Response) => {
    const publicKey = ENV.sendcloudPublicKey;
    const secretKey = ENV.sendcloudSecretKey;

    if (!publicKey || !secretKey) {
      res.json({ methods: [], error: "Sendcloud nicht konfiguriert" });
      return;
    }

    try {
      const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
      const response = await fetch(
        "https://panel.sendcloud.sc/api/v2/shipping_methods?to_country=DE",
        { headers: { Authorization: `Basic ${credentials}` } }
      );

      if (!response.ok) {
        res.json({ methods: [], error: `Sendcloud API Fehler: ${response.status}` });
        return;
      }

      const data = (await response.json()) as {
        shipping_methods: Array<{
          id: number;
          name: string;
          carrier: string;
          min_weight: string;
          max_weight: string;
        }>;
      };

      res.json({
        methods: data.shipping_methods.map((m) => ({
          id: m.id,
          name: m.name,
          carrier: m.carrier,
          minWeight: m.min_weight,
          maxWeight: m.max_weight,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ methods: [], error: `Netzwerkfehler: ${err.message}` });
    }
  }
);
