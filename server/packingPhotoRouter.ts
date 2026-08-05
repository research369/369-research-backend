/**
 * packingPhotoRouter.ts – Pflichtfoto beim Packvorgang
 *
 * Endpunkte:
 *   POST /api/orders/:orderId/packing-photo  – Foto hochladen (Base64)
 *   GET  /api/orders/:orderId/packing-photo  – Foto abrufen (als Bild)
 *   DELETE /api/orders/:orderId/packing-photo – Foto löschen
 *
 * Speicherung: packing_photo_data (TEXT) in Railway PostgreSQL – dauerhaft.
 * Auth: requireWawiAdmin (JWT) für alle Endpunkte.
 * Additiv: keine bestehenden Router oder Endpunkte werden verändert.
 */

import { Router, type Request, type Response } from "express";
import { getPool } from "./db.js";
import { getUserFromRequest } from "./auth.js";
import { ENV } from "./env.js";

// Flexible Auth: JWT Cookie, Bearer Token oder x-wawi-key
async function requirePackingAuth(req: any, res: any, next: () => void): Promise<void> {
  // 1. x-wawi-key (interner WaWi-Key)
  const wawiKey = req.headers["x-wawi-key"];
  if (wawiKey && wawiKey === ENV.wawiInternalKey) { next(); return; }
  // 2. JWT Cookie oder Bearer Token
  const user = await getUserFromRequest(req);
  if (user) { next(); return; }
  res.status(401).json({ success: false, error: "Nicht angemeldet" });
}

export const packingPhotoRouter = Router();

// ─── POST /api/orders/:orderId/packing-photo ─────────────────────────────────
packingPhotoRouter.post(
  "/api/orders/:orderId/packing-photo",
  requirePackingAuth,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    const { photoData } = req.body as { photoData?: string };

    if (!orderId) { res.status(400).json({ success: false, error: "orderId fehlt" }); return; }
    if (!photoData || !photoData.startsWith("data:image/")) {
      res.status(400).json({ success: false, error: "photoData fehlt oder ungültiges Format" });
      return;
    }
    if (photoData.length > 14_000_000) {
      res.status(413).json({ success: false, error: "Foto zu groß (max. 10 MB)" });
      return;
    }

    const pool = await getPool();
    if (!pool) { res.status(503).json({ success: false, error: "Datenbank nicht verfügbar" }); return; }

    // Prüfen ob Bestellung existiert
    const check = await pool.query("SELECT order_id FROM orders WHERE order_id = $1", [orderId]);
    if (check.rowCount === 0) {
      res.status(404).json({ success: false, error: `Bestellung ${orderId} nicht gefunden` });
      return;
    }

    const photoUrl = `/api/orders/${orderId}/packing-photo`;
    const photoTimestamp = new Date().toISOString();

    await pool.query(
      `UPDATE orders SET 
        packing_photo_data = $1,
        packing_photo_url = $2,
        packing_photo_at = $3,
        updated_at = NOW()
       WHERE order_id = $4`,
      [photoData, photoUrl, photoTimestamp, orderId]
    );

    console.log(`[packingPhoto] Foto gespeichert für ${orderId} | ${Math.round(photoData.length / 1024)} KB`);
    res.json({ success: true, orderId, photoUrl, photoAt: photoTimestamp });
  }
);

// ─── GET /api/orders/:orderId/packing-photo ──────────────────────────────────
packingPhotoRouter.get(
  "/api/orders/:orderId/packing-photo",
  requirePackingAuth,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    if (!orderId) { res.status(400).json({ success: false, error: "orderId fehlt" }); return; }

    const pool = await getPool();
    if (!pool) { res.status(503).json({ success: false, error: "Datenbank nicht verfügbar" }); return; }

    const result = await pool.query(
      "SELECT packing_photo_data, packing_photo_at FROM orders WHERE order_id = $1",
      [orderId]
    );

    const row = result.rows[0];
    if (!row || !row.packing_photo_data) {
      res.status(404).json({ success: false, error: "Kein Foto für diese Bestellung vorhanden" });
      return;
    }

    const photoData: string = row.packing_photo_data;
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
packingPhotoRouter.delete(
  "/api/orders/:orderId/packing-photo",
  requirePackingAuth,
  async (req: Request, res: Response) => {
    const orderId = String(req.params.orderId ?? "").trim();
    const pool = await getPool();
    if (!pool) { res.status(503).json({ success: false, error: "DB nicht verfügbar" }); return; }
    await pool.query(
      "UPDATE orders SET packing_photo_data = NULL, packing_photo_url = NULL, packing_photo_at = NULL WHERE order_id = $1",
      [orderId]
    );
    res.json({ success: true });
  }
);
