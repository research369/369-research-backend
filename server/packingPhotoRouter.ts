/**
 * packingPhotoRouter.ts – Pflichtfoto beim Packvorgang
 *
 * Endpunkte:
 *   POST /api/orders/:orderId/packing-photo  – Foto hochladen (Base64 oder Multipart)
 *   GET  /api/orders/:orderId/packing-photo  – Foto abrufen
 *
 * Speicherung:
 *   - Foto wird als Base64 in der DB-Spalte packing_photo_data gespeichert (TEXT)
 *   - Zusätzlich wird packing_photo_url auf /api/orders/:orderId/packing-photo gesetzt
 *   - Fotos sind dauerhaft in Railway PostgreSQL gespeichert – nie verlierbar
 *   - Kein externer Storage nötig – DB ist die einzige Source of Truth
 *
 * Sicherheit:
 *   - Alle Endpunkte erfordern WaWi-Admin-Auth (JWT)
 *   - Fotos sind nur für authentifizierte WaWi-Nutzer abrufbar
 *
 * Additiv: Keine bestehenden Router oder Endpunkte werden verändert.
 */

import { Router, type Request, type Response } from "express";
import { requireWawiAdmin } from "./dhlExpressRouter.js";
import { getDb } from "./db.js";
import { orders } from "./schema.js";
import { eq } from "drizzle-orm";

export const packingPhotoRouter = Router();

// ─── POST /api/orders/:orderId/packing-photo ─────────────────────────────────
// Nimmt ein Foto als Base64-String entgegen und speichert es in der DB.
// Body: { photoData: "data:image/jpeg;base64,..." }
packingPhotoRouter.post(
  "/api/orders/:orderId/packing-photo",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    const { photoData } = req.body as { photoData?: string };

    if (!orderId) {
      res.status(400).json({ success: false, error: "orderId fehlt" });
      return;
    }
    if (!photoData || !photoData.startsWith("data:image/")) {
      res.status(400).json({ success: false, error: "photoData fehlt oder ungültiges Format (erwartet: data:image/...;base64,...)" });
      return;
    }
    // Max 10 MB
    if (photoData.length > 14_000_000) {
      res.status(413).json({ success: false, error: "Foto zu groß (max. 10 MB)" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ success: false, error: "Datenbank nicht verfügbar" });
      return;
    }

    // Prüfen ob Bestellung existiert
    const [order] = await db.select({ orderId: orders.orderId }).from(orders).where(eq(orders.orderId, orderId)).limit(1);
    if (!order) {
      res.status(404).json({ success: false, error: `Bestellung ${orderId} nicht gefunden` });
      return;
    }

    // Foto in DB speichern
    const photoUrl = `/api/orders/${orderId}/packing-photo`;
    const photoTimestamp = new Date().toISOString();

    await (db as any).execute(
      `UPDATE orders SET 
        packing_photo_data = $1,
        packing_photo_url = $2,
        packing_photo_at = $3,
        updated_at = NOW()
       WHERE order_id = $4`,
      [photoData, photoUrl, photoTimestamp, orderId]
    );

    console.log(`[packingPhoto] Foto gespeichert für ${orderId} | Größe: ${Math.round(photoData.length / 1024)} KB`);

    res.json({
      success: true,
      orderId,
      photoUrl,
      photoAt: photoTimestamp,
    });
  }
);

// ─── GET /api/orders/:orderId/packing-photo ──────────────────────────────────
// Gibt das gespeicherte Foto zurück (als JSON mit Base64 oder direkt als Bild).
packingPhotoRouter.get(
  "/api/orders/:orderId/packing-photo",
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

    const result = await (db as any).execute(
      `SELECT packing_photo_data, packing_photo_at FROM orders WHERE order_id = $1`,
      [orderId]
    );

    const row = result?.rows?.[0];
    if (!row || !row.packing_photo_data) {
      res.status(404).json({ success: false, error: "Kein Foto für diese Bestellung vorhanden" });
      return;
    }

    const photoData: string = row.packing_photo_data;

    // Als Bild direkt ausliefern
    const mimeMatch = photoData.match(/^data:([^;]+);base64,/);
    if (mimeMatch) {
      const mimeType = mimeMatch[1];
      const base64 = photoData.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(base64, "base64");
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(buffer);
    } else {
      res.json({ success: true, photoData, photoAt: row.packing_photo_at });
    }
  }
);

// ─── DELETE /api/orders/:orderId/packing-photo ───────────────────────────────
// Löscht das Foto (nur für Admins, z.B. bei Fehler).
packingPhotoRouter.delete(
  "/api/orders/:orderId/packing-photo",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    const db = await getDb();
    if (!db) { res.status(503).json({ success: false, error: "DB nicht verfügbar" }); return; }

    await (db as any).execute(
      `UPDATE orders SET packing_photo_data = NULL, packing_photo_url = NULL, packing_photo_at = NULL WHERE order_id = $1`,
      [orderId]
    );
    res.json({ success: true });
  }
);
