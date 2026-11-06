import jwt from "jsonwebtoken";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { ENV } from "./env.js";
import { partners } from "../drizzle/schema.js";

export const PARTNER_TOKEN_EXPIRY = "30d";
export const PARTNER_COOKIE_NAME = "369_partner_session";
export function createPartnerToken(partnerId: number, sessionVersion = 0): string {
  return jwt.sign({ partnerId, type: "partner", sessionVersion }, ENV.jwtSecret, { expiresIn: PARTNER_TOKEN_EXPIRY });
}
export function verifyPartnerToken(token: string): { partnerId: number; sessionVersion: number } | null {
  try {
    const payload = jwt.verify(token, ENV.jwtSecret) as { partnerId?: unknown; type?: unknown; sessionVersion?: unknown };
    if (payload.type !== "partner" || !Number.isInteger(payload.partnerId) || Number(payload.partnerId) < 1) return null;
    // Rolling transition: only pre-version tokens on unchanged version-0 accounts.
    const version = payload.sessionVersion === undefined ? 0 : payload.sessionVersion;
    if (!Number.isInteger(version) || Number(version) < 0) return null;
    return { partnerId: payload.partnerId as number, sessionVersion: version as number };
  } catch { return null; }
}
/** Attribution codes/numbers are never authorization. Every session reads DB. */
export async function getAuthenticatedPartnerFromRequest(req: Request) {
  const authorization = req.headers.authorization;
  let token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (!token) {
    const cookies = Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((entry) => {
      const [key, ...value] = entry.trim().split("=");
      return [key, value.join("=")];
    }));
    token = cookies[PARTNER_COOKIE_NAME];
  }
  if (!token) return null;
  const payload = verifyPartnerToken(token);
  if (!payload) return null;
  const db = await getDb();
  if (!db) return null;
  const [partner] = await db.select().from(partners)
    .where(and(eq(partners.id, payload.partnerId), eq(partners.isActive, 1), eq(partners.sessionVersion, payload.sessionVersion)))
    .limit(1);
  return partner || null;
}
