import jwt from "jsonwebtoken";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { ENV } from "./env.js";
import { partners } from "../drizzle/schema.js";

export const PARTNER_TOKEN_EXPIRY = "30d";
export const PARTNER_COOKIE_NAME = "369_partner_session";

export function createPartnerToken(partnerId: number): string {
  return jwt.sign({ partnerId, type: "partner" }, ENV.jwtSecret, { expiresIn: PARTNER_TOKEN_EXPIRY });
}

export function verifyPartnerToken(token: string): { partnerId: number } | null {
  try {
    const payload = jwt.verify(token, ENV.jwtSecret) as { partnerId?: unknown; type?: unknown };
    if (payload.type !== "partner" || typeof payload.partnerId !== "number") return null;
    return { partnerId: payload.partnerId };
  } catch {
    return null;
  }
}

/**
 * Resolves a partner identity exclusively from a valid first-party session.
 * A public partner code or number is an attribution value, never authorization
 * for financial actions such as credit redemption.
 */
export async function getAuthenticatedPartnerFromRequest(req: Request) {
  const authorization = req.headers.authorization;
  let token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;

  if (!token) {
    const cookieHeader = req.headers.cookie || "";
    const cookies = Object.fromEntries(
      cookieHeader.split(";").filter(Boolean).map((entry) => {
        const [key, ...value] = entry.trim().split("=");
        return [key, value.join("=")];
      }),
    );
    token = cookies[PARTNER_COOKIE_NAME];
  }

  if (!token) return null;
  const payload = verifyPartnerToken(token);
  if (!payload) return null;

  const db = await getDb();
  if (!db) return null;
  const [partner] = await db.select().from(partners)
    .where(and(eq(partners.id, payload.partnerId), eq(partners.isActive, 1)))
    .limit(1);
  return partner || null;
}
