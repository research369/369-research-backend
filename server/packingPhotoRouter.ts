/**
 * packingPhotoRouter.ts – dauerhafte Packfoto-Nachweise beim Packvorgang
 *
 * Endpunkte:
 *   POST /api/orders/:orderId/packing-photo       – erstes Pflichtfoto speichern
 *   GET  /api/orders/:orderId/packing-photo       – neuesten Nachweis abrufen
 *   GET  /api/orders/:orderId/packing-photos      – Nachweis-Historie auflisten
 *   POST /api/orders/:orderId/packing-photos      – zusätzlichen Nachweis hinzufügen
 *   GET  /api/orders/:orderId/packing-photos/:id  – einen Nachweis abrufen
 *
 * Alle Fotos bleiben dauerhaft in PostgreSQL. Zusätzliche Aufnahmen ergänzen
 * die Historie und überschreiben niemals ältere Nachweise.
 */

import { Router, type Request, type Response } from "express";
import { getPool } from "./db.js";
import { getUserFromRequest } from "./auth.js";
import { ENV } from "./env.js";

async function requirePackingAuth(req: any, res: any, next: () => void): Promise<void> {
  const wawiKey = req.headers["x-wawi-key"];
  if (wawiKey && wawiKey === ENV.wawiInternalKey) { next(); return; }
  const user = await getUserFromRequest(req);
  if (user) { next(); return; }
  res.status(401).json({ success: false, error: "Nicht angemeldet" });
}

function orderIdFrom(req: Request): string {
  return String(req.params.orderId ?? "").trim();
}

function parsePhotoData(req: Request, res: Response): string | null {
  const photoData = (req.body as { photoData?: string }).photoData;
  if (!photoData || !photoData.startsWith("data:image/")) {
    res.status(400).json({ success: false, error: "photoData fehlt oder hat kein gültiges Bildformat" });
    return null;
  }
  if (photoData.length > 14_000_000) {
    res.status(413).json({ success: false, error: "Foto zu groß (max. 10 MB)" });
    return null;
  }
  return photoData;
}

function sendPhoto(res: Response, photoData: string): void {
  const mimeMatch = photoData.match(/^data:([^;]+);base64,/);
  if (!mimeMatch) {
    res.status(500).json({ success: false, error: "Gespeichertes Packfoto hat kein lesbares Bildformat" });
    return;
  }
  const base64 = photoData.replace(/^data:[^;]+;base64,/, "");
  const buffer = Buffer.from(base64, "base64");
  res.setHeader("Content-Type", mimeMatch[1]);
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(buffer);
}

async function orderExists(orderId: string): Promise<boolean> {
  const pool = await getPool();
  if (!pool) throw new Error("Datenbank nicht verfügbar");
  const result = await pool.query("SELECT 1 FROM orders WHERE order_id = $1", [orderId]);
  return (result.rowCount ?? 0) > 0;
}

export const packingPhotoRouter = Router();

// Erstes Pflichtfoto: bleibt mit den bisherigen orders-Spalten kompatibel und
// wird gleichzeitig als unveränderlicher initialer Nachweis dokumentiert.
packingPhotoRouter.post("/api/orders/:orderId/packing-photo", requirePackingAuth, async (req: Request, res: Response) => {
  const orderId = orderIdFrom(req);
  const photoData = parsePhotoData(req, res);
  if (!orderId || !photoData) return;

  try {
    if (!(await orderExists(orderId))) {
      res.status(404).json({ success: false, error: `Bestellung ${orderId} nicht gefunden` });
      return;
    }
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const photoAt = new Date().toISOString();
    const photoUrl = `/api/orders/${orderId}/packing-photo`;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existingHistory = await client.query(
        "SELECT 1 FROM packing_photo_history WHERE order_id = $1 LIMIT 1",
        [orderId],
      );
      const hasHistory = (existingHistory.rowCount ?? 0) > 0;
      if (hasHistory) {
        // A retry after a disrupted response must never hide a prior proof.
        // Preserve it as a new evidence record rather than rewriting history.
        await client.query(
          `INSERT INTO packing_photo_history (order_id, photo_data, photo_at, source, created_at)
           VALUES ($1, $2, $3, 'retake', $3)`,
          [orderId, photoData, photoAt],
        );
        await client.query(
          `UPDATE orders
           SET packing_photo_url = $1, packing_photo_at = $2, updated_at = NOW()
           WHERE order_id = $3`,
          [photoUrl, photoAt, orderId],
        );
      } else {
        await client.query(
          `UPDATE orders
           SET packing_photo_data = $1, packing_photo_url = $2, packing_photo_at = $3, updated_at = NOW()
           WHERE order_id = $4`,
          [photoData, photoUrl, photoAt, orderId],
        );
        await client.query(
          `INSERT INTO packing_photo_history (order_id, photo_data, photo_at, source, created_at)
           VALUES ($1, $2, $3, 'initial', $3)`,
          [orderId, photoData, photoAt],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    console.log(`[packingPhoto] Erstes Foto gespeichert für ${orderId}`);
    res.json({ success: true, orderId, photoUrl, photoAt });
  } catch (error) {
    console.error("[packingPhoto] Erstes Foto konnte nicht gespeichert werden", error);
    res.status(503).json({ success: false, error: "Packfoto konnte nicht dauerhaft gespeichert werden" });
  }
});

// Zusätzliche Aufnahmen sind append-only: ältere Nachweise bleiben jederzeit abrufbar.
packingPhotoRouter.post("/api/orders/:orderId/packing-photos", requirePackingAuth, async (req: Request, res: Response) => {
  const orderId = orderIdFrom(req);
  const photoData = parsePhotoData(req, res);
  if (!orderId || !photoData) return;

  try {
    if (!(await orderExists(orderId))) {
      res.status(404).json({ success: false, error: `Bestellung ${orderId} nicht gefunden` });
      return;
    }
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const photoAt = new Date().toISOString();
    const inserted = await pool.query(
      `INSERT INTO packing_photo_history (order_id, photo_data, photo_at, source, created_at)
       VALUES ($1, $2, $3, 'retake', $3)
       RETURNING id, photo_at`,
      [orderId, photoData, photoAt],
    );
    await pool.query(
      `UPDATE orders
       SET packing_photo_url = $1, packing_photo_at = $2, updated_at = NOW()
       WHERE order_id = $3`,
      [`/api/orders/${orderId}/packing-photo`, photoAt, orderId],
    );

    const photo = inserted.rows[0];
    console.log(`[packingPhoto] Zusätzlicher Nachweis ${photo.id} für ${orderId} gespeichert`);
    res.status(201).json({ success: true, orderId, photoId: photo.id, photoAt: photo.photo_at });
  } catch (error) {
    console.error("[packingPhoto] Zusätzlicher Nachweis konnte nicht gespeichert werden", error);
    res.status(503).json({ success: false, error: "Zusätzliches Packfoto konnte nicht dauerhaft gespeichert werden" });
  }
});

packingPhotoRouter.get("/api/orders/:orderId/packing-photos", requirePackingAuth, async (req: Request, res: Response) => {
  const orderId = orderIdFrom(req);
  if (!orderId) { res.status(400).json({ success: false, error: "orderId fehlt" }); return; }

  try {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const result = await pool.query(
      `SELECT id, photo_at, source
       FROM packing_photo_history
       WHERE order_id = $1
       ORDER BY photo_at DESC, id DESC`,
      [orderId],
    );
    res.json({ success: true, photos: result.rows.map((row) => ({
      id: row.id,
      createdAt: row.photo_at,
      source: row.source,
    })) });
  } catch (error) {
    console.error("[packingPhoto] Historie konnte nicht geladen werden", error);
    res.status(503).json({ success: false, error: "Packfoto-Historie konnte nicht geladen werden" });
  }
});

packingPhotoRouter.get("/api/orders/:orderId/packing-photos/:photoId", requirePackingAuth, async (req: Request, res: Response) => {
  const orderId = orderIdFrom(req);
  const photoId = Number(req.params.photoId);
  if (!orderId || !Number.isInteger(photoId) || photoId <= 0) {
    res.status(400).json({ success: false, error: "orderId oder photoId ungültig" });
    return;
  }

  try {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const result = await pool.query(
      "SELECT photo_data FROM packing_photo_history WHERE order_id = $1 AND id = $2 LIMIT 1",
      [orderId, photoId],
    );
    if (!result.rowCount) { res.status(404).json({ success: false, error: "Packfoto nicht gefunden" }); return; }
    sendPhoto(res, result.rows[0].photo_data);
  } catch (error) {
    console.error("[packingPhoto] Historienfoto konnte nicht geladen werden", error);
    res.status(503).json({ success: false, error: "Packfoto konnte nicht geladen werden" });
  }
});

// Der Standardabruf liefert immer den neuesten Nachweis. Für alte Bestellungen
// ohne Historieneintrag bleibt ein Fallback auf die bestehende orders-Spalte.
packingPhotoRouter.get("/api/orders/:orderId/packing-photo", requirePackingAuth, async (req: Request, res: Response) => {
  const orderId = orderIdFrom(req);
  if (!orderId) { res.status(400).json({ success: false, error: "orderId fehlt" }); return; }

  try {
    const pool = await getPool();
    if (!pool) throw new Error("Datenbank nicht verfügbar");
    const history = await pool.query(
      `SELECT photo_data
       FROM packing_photo_history
       WHERE order_id = $1
       ORDER BY photo_at DESC, id DESC
       LIMIT 1`,
      [orderId],
    );
    if (history.rowCount) { sendPhoto(res, history.rows[0].photo_data); return; }

    const legacy = await pool.query(
      "SELECT packing_photo_data FROM orders WHERE order_id = $1",
      [orderId],
    );
    if (!legacy.rowCount || !legacy.rows[0].packing_photo_data) {
      res.status(404).json({ success: false, error: "Kein Foto für diese Bestellung vorhanden" });
      return;
    }
    sendPhoto(res, legacy.rows[0].packing_photo_data);
  } catch (error) {
    console.error("[packingPhoto] Aktuelles Foto konnte nicht geladen werden", error);
    res.status(503).json({ success: false, error: "Packfoto konnte nicht geladen werden" });
  }
});

// Packfoto-Nachweise sind dauerhaft. Ein Löschaufruf darf niemals Daten entfernen.
packingPhotoRouter.delete("/api/orders/:orderId/packing-photo", requirePackingAuth, (_req: Request, res: Response) => {
  res.status(405).json({ success: false, error: "Packfoto-Nachweise sind dauerhaft und können nicht gelöscht werden" });
});
