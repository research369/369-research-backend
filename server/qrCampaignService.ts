import crypto from "crypto";
import type { Request } from "express";
import { getPool } from "./db.js";
import { ENV } from "./env.js";

export const QR_ATTRIBUTION_DAYS = 30;
export const QR_PUBLIC_BASE_URL = (process.env.QR_PUBLIC_BASE_URL || "https://q.369research.eu").replace(/\/$/, "");

export type QrAttribution = {
  campaignId: number;
  attributionToken: string;
  shortCode: string;
  campaignName: string;
  medium: string | null;
  locationPartner: string | null;
};

export function createOpaqueToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function classifyDevice(userAgent: string): "mobile" | "tablet" | "desktop" | "bot" | "unknown" {
  const ua = userAgent.toLowerCase();
  if (!ua) return "unknown";
  if (/bot|crawler|spider|preview|facebookexternalhit|whatsapp/.test(ua)) return "bot";
  if (/ipad|tablet|kindle|silk/.test(ua)) return "tablet";
  if (/mobi|iphone|android/.test(ua)) return "mobile";
  return "desktop";
}

export function hashIp(ip: string): string | null {
  if (!ip) return null;
  return crypto.createHmac("sha256", ENV.jwtSecret).update(ip).digest("hex");
}

export async function resolveQrAttribution(token?: string | null): Promise<QrAttribution | null> {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const pool = await getPool();
  if (!pool) throw new Error("Database not available");
  const result = await pool.query(
    `SELECT a.campaign_id, a.attribution_token, c.short_code, c.name,
            c.medium, c.location_partner
       FROM qr_attributions a
       JOIN qr_campaigns c ON c.id = a.campaign_id
      WHERE a.attribution_token = $1 AND a.expires_at >= NOW()
      LIMIT 1`,
    [token],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    campaignId: row.campaign_id,
    attributionToken: row.attribution_token,
    shortCode: row.short_code,
    campaignName: row.name,
    medium: row.medium,
    locationPartner: row.location_partner,
  };
}

export function buildTrackedTarget(targetUrl: string, input: {
  shortCode: string;
  attributionToken: string;
  campaign?: string | null;
  medium?: string | null;
}): string {
  const url = new URL(targetUrl);
  url.searchParams.set("_qr", input.attributionToken);
  url.searchParams.set("qr_code", input.shortCode);
  if (!url.searchParams.has("utm_source")) url.searchParams.set("utm_source", "qr");
  if (input.medium && !url.searchParams.has("utm_medium")) url.searchParams.set("utm_medium", input.medium);
  if (input.campaign && !url.searchParams.has("utm_campaign")) url.searchParams.set("utm_campaign", input.campaign);
  return url.toString();
}
