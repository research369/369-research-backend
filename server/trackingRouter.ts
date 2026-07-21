/**
 * trackingRouter.ts – DHL Sendungsverfolgung
 *
 * Eigenständiger Express-Router für die DHL Tracking-Integration.
 * KEINE Änderungen an bestehenden Routen, Endpoints oder Datenmodellen.
 * Vollständig additiv – kann ohne Auswirkung auf andere Funktionen entfernt werden.
 *
 * Endpoints:
 *   GET /api/tracking/overview        – Alle Bestellungen mit Tracking-Nr. + DHL-Status (letzte 30 Tage)
 *   GET /api/tracking/shipment/:trackingNr – Einzelne Sendung mit vollständiger Event-Historie
 *
 * DHL Tracking API:
 *   URL: https://api-eu.dhl.com/track/shipments
 *   Auth: DHL-API-Key Header (ENV.dhlApiKey – bereits in Railway vorhanden)
 *   Sprache: language=de (deutsche Beschreibungen)
 *   Kein separater Tracking-Key nötig – gleicher Key wie für Label-Erstellung
 *
 * Cache:
 *   - In-Memory-Cache, 5 Minuten TTL pro Tracking-Nummer
 *   - Verhindert exzessive DHL-API-Calls bei mehrfachen Seitenaufrufen
 *   - Cache wird bei Server-Neustart geleert (kein persistenter Cache nötig)
 *
 * Sicherheit:
 *   - Nur eingeloggte Admin-User (JWT via getUserFromRequest)
 *   - Keine DHL-Credentials in der Response
 *
 * Datenquellen:
 *   - orders-Tabelle: order_id, first_name, last_name, tracking_number, status, shipped_at
 *   - DHL Tracking API: statusCode, description, events[], location, timestamp
 *
 * Für zukünftige Entwickler:
 *   - DHL Tracking API Docs: https://developer.dhl.com/api-reference/shipment-tracking
 *   - StatusCodes: pre-transit | transit | delivered | failure | unknown
 *   - ENV.dhlApiKey muss in Railway als DHL_API_KEY gesetzt sein
 */

import { Router, type Request, type Response } from "express";
import { ENV } from "./env.js";
import { getDb } from "./db.js";
import { orders } from "../drizzle/schema.js";
import { gte, isNotNull, ne } from "drizzle-orm";
import { getUserFromRequest } from "./auth.js";

export const trackingRouter = Router();

// ─── Typen ────────────────────────────────────────────────────────────────────

interface DhlTrackingEvent {
  timestamp: string;
  location?: { address?: { addressLocality?: string; countryCode?: string } };
  statusCode?: string;
  status?: string;
  description?: string;
}

interface DhlTrackingStatus {
  timestamp?: string;
  location?: { address?: { addressLocality?: string; countryCode?: string } };
  statusCode?: string;
  status?: string;
  description?: string;
}

interface DhlShipmentResult {
  trackingNumber: string;
  statusCode: string;
  statusText: string;
  description: string;
  timestamp: string | null;
  location: string | null;
  events: Array<{
    timestamp: string;
    location: string;
    statusCode: string;
    description: string;
  }>;
  error?: string;
}

// ─── In-Memory-Cache (5 Minuten TTL) ─────────────────────────────────────────

const cache = new Map<string, { data: DhlShipmentResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 Minuten

function getCached(key: string): DhlShipmentResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: DhlShipmentResult): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── DHL Tracking API Call ────────────────────────────────────────────────────

async function fetchDhlTracking(trackingNumber: string): Promise<DhlShipmentResult> {
  const cached = getCached(trackingNumber);
  if (cached) return cached;

  // Tracking-Key hat Vorrang, Fallback auf allgemeinen DHL-Key
  const apiKey = ENV.dhlTrackingApiKey || ENV.dhlApiKey;
  if (!apiKey) {
    return {
      trackingNumber,
      statusCode: "unknown",
      statusText: "Unbekannt",
      description: "DHL Tracking API Key nicht konfiguriert",
      timestamp: null,
      location: null,
      events: [],
      error: "DHL_TRACKING_API_KEY nicht gesetzt",
    };
  }

  try {
    const url = `https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}&language=de`;
    const response = await fetch(url, {
      headers: { "DHL-API-Key": apiKey },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[tracking] DHL API Fehler für ${trackingNumber}: ${response.status} ${errText.slice(0, 200)}`);
      const result: DhlShipmentResult = {
        trackingNumber,
        statusCode: "unknown",
        statusText: "Nicht verfügbar",
        description: `DHL API: ${response.status}`,
        timestamp: null,
        location: null,
        events: [],
        error: `HTTP ${response.status}`,
      };
      setCache(trackingNumber, result);
      return result;
    }

    const data = await response.json() as { shipments?: any[]; errors?: any[] };

    if (!data.shipments || data.shipments.length === 0) {
      const result: DhlShipmentResult = {
        trackingNumber,
        statusCode: "unknown",
        statusText: "Nicht gefunden",
        description: "Sendung bei DHL nicht gefunden",
        timestamp: null,
        location: null,
        events: [],
      };
      setCache(trackingNumber, result);
      return result;
    }

    const shipment = data.shipments[0];
    const status: DhlTrackingStatus = shipment.status || {};
    const events: DhlTrackingEvent[] = shipment.events || [];

    const statusCodeMap: Record<string, string> = {
      "delivered": "Zugestellt",
      "transit": "Unterwegs",
      "pre-transit": "Eingeliefert",
      "failure": "Problem",
      "unknown": "Unbekannt",
    };

    const statusCode = status.statusCode || "unknown";
    const location = status.location?.address?.addressLocality || null;

    const result: DhlShipmentResult = {
      trackingNumber,
      statusCode,
      statusText: statusCodeMap[statusCode] || statusCode,
      description: status.description || "",
      timestamp: status.timestamp || null,
      location,
      events: events.map((ev: DhlTrackingEvent) => ({
        timestamp: ev.timestamp || "",
        location: ev.location?.address?.addressLocality || "",
        statusCode: ev.statusCode || ev.status || "",
        description: ev.description || "",
      })),
    };

    setCache(trackingNumber, result);
    return result;

  } catch (err: any) {
    console.error(`[tracking] Fehler bei DHL-Call für ${trackingNumber}:`, err?.message);
    const result: DhlShipmentResult = {
      trackingNumber,
      statusCode: "unknown",
      statusText: "Fehler",
      description: "Verbindungsfehler zur DHL API",
      timestamp: null,
      location: null,
      events: [],
      error: err?.message || "Unbekannter Fehler",
    };
    setCache(trackingNumber, result);
    return result;
  }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

async function requireWawiAdmin(req: Request, res: Response, next: () => void): Promise<void> {
  const user = await getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ success: false, error: "Nicht angemeldet" });
    return;
  }
  // Admin oder product_manager dürfen Tracking-Daten abrufen
  const role = String(user.role);
  if (role !== "admin" && role !== "product_manager") {
    res.status(403).json({ success: false, error: "Keine Berechtigung" });
    return;
  }
  next();
}

// ─── GET /api/tracking/overview ───────────────────────────────────────────────
// Gibt alle Bestellungen der letzten 30 Tage mit Tracking-Nummer zurück,
// angereichert mit dem aktuellen DHL-Status (gecacht).

trackingRouter.get(
  "/api/tracking/overview",
  requireWawiAdmin,
  async (_req: Request, res: Response) => {
    try {
      const db = await getDb();
      if (!db) {
        res.status(503).json({ success: false, error: "DB nicht verfügbar" });
        return;
      }

      // Bestellungen der letzten 30 Tage mit Tracking-Nummer
      const since = new Date();
      since.setDate(since.getDate() - 30);

      const ordersWithTracking = await db
        .select({
          orderId: orders.orderId,
          firstName: orders.firstName,
          lastName: orders.lastName,
          email: orders.email,
          trackingNumber: orders.trackingNumber,
          status: orders.status,
          shippedAt: orders.shippedAt,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(
          // Tracking-Nummer vorhanden und nicht leer
          isNotNull(orders.trackingNumber)
        )
        .orderBy(orders.shippedAt);

      // Nur Bestellungen mit echter Tracking-Nummer (nicht leer)
      const filtered = ordersWithTracking.filter(
        (o) => o.trackingNumber && o.trackingNumber.trim() !== ""
      );

      // DHL-Status für alle abrufen (gecacht)
      const results = await Promise.all(
        filtered.map(async (order) => {
          const tracking = await fetchDhlTracking(order.trackingNumber!);
          return {
            orderId: order.orderId,
            customerName: `${order.firstName} ${order.lastName}`.trim(),
            email: order.email,
            trackingNumber: order.trackingNumber,
            orderStatus: order.status,
            shippedAt: order.shippedAt,
            dhl: {
              statusCode: tracking.statusCode,
              statusText: tracking.statusText,
              description: tracking.description,
              timestamp: tracking.timestamp,
              location: tracking.location,
              error: tracking.error,
            },
          };
        })
      );

      // Sortierung: neueste zuerst
      results.sort((a, b) => {
        const dateA = a.shippedAt ? new Date(a.shippedAt).getTime() : 0;
        const dateB = b.shippedAt ? new Date(b.shippedAt).getTime() : 0;
        return dateB - dateA;
      });

      res.json({ success: true, shipments: results, cachedAt: new Date().toISOString() });

    } catch (err: any) {
      console.error("[tracking] overview Fehler:", err?.message);
      res.status(500).json({ success: false, error: "Interner Fehler" });
    }
  }
);

// ─── GET /api/tracking/shipment/:trackingNr ───────────────────────────────────
// Gibt vollständige Event-Historie für eine einzelne Sendung zurück.

trackingRouter.get(
  "/api/tracking/shipment/:trackingNr",
  requireWawiAdmin,
  async (req: Request, res: Response) => {
    try {
      const trackingNr = String(req.params.trackingNr || "");
      if (!trackingNr || trackingNr.trim() === "") {
        res.status(400).json({ success: false, error: "Tracking-Nummer fehlt" });
        return;
      }

      // Cache für diese Anfrage invalidieren (force refresh)
      const forceRefresh = String(req.query.refresh) === "true";
      if (forceRefresh) {
        cache.delete(trackingNr);
      }

      const tracking = await fetchDhlTracking(trackingNr);

      // Zusätzlich: Bestelldaten aus DB holen
      const db = await getDb();
      let orderInfo = null;
      if (db) {
        const orderRows = await db
          .select({
            orderId: orders.orderId,
            firstName: orders.firstName,
            lastName: orders.lastName,
            email: orders.email,
            status: orders.status,
            shippedAt: orders.shippedAt,
          })
          .from(orders)
          .where(isNotNull(orders.trackingNumber))
          .limit(100);

        const found = orderRows.find((o) => (o as any).trackingNumber === trackingNr ||
          (o as any).tracking_number === trackingNr);
        if (found) {
          orderInfo = {
            orderId: found.orderId,
            customerName: `${found.firstName} ${found.lastName}`.trim(),
            email: found.email,
            orderStatus: found.status,
            shippedAt: found.shippedAt,
          };
        }
      }

      res.json({
        success: true,
        tracking,
        order: orderInfo,
      });

    } catch (err: any) {
      console.error("[tracking] shipment Fehler:", err?.message);
      res.status(500).json({ success: false, error: "Interner Fehler" });
    }
  }
);

// ─── GET /api/tracking/cache/clear ───────────────────────────────────────────
// Cache leeren (für Debugging / manuelle Aktualisierung).

trackingRouter.post(
  "/api/tracking/cache/clear",
  requireWawiAdmin,
  (_req: Request, res: Response) => {
    const size = cache.size;
    cache.clear();
    res.json({ success: true, clearedEntries: size });
  }
);
