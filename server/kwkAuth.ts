import type { Pool } from "pg";
import jwt from "jsonwebtoken";
import { createHmac } from "node:crypto";
import { getPool } from "./db.js";
import { ENV } from "./env.js";

const KWK_TOKEN_EXPIRY = "30d";
const KWK_DEMO_AUDIENCE = "369-kwk-demo";
const KWK_DEMO_ISSUER = "369-kwk-demo-service";

// A derived key makes the demo signing domain cryptographically distinct from
// both productive KWK tokens and the WaWi session token, although all values
// remain rooted in the single existing server secret.
function getKwkDemoSigningKey(): string {
  return createHmac("sha256", ENV.jwtSecret).update("369:kwk:demo:jwt:v1").digest("hex");
}

export function createKwkToken(kwkId: number, sessionVersion = 0): string {
  return jwt.sign({ kwkId, type: "kwk", sessionVersion }, ENV.jwtSecret, { expiresIn: KWK_TOKEN_EXPIRY });
}

export function verifyKwkToken(token: string): { kwkId: number; sessionVersion: number } | null {
  try {
    const payload = jwt.verify(token, ENV.jwtSecret) as { kwkId?: unknown; type?: unknown; sessionVersion?: unknown };
    if (payload.type !== "kwk" || !Number.isInteger(payload.kwkId)) return null;
    const version = payload.sessionVersion === undefined ? 0 : payload.sessionVersion;
    if (!Number.isInteger(version) || Number(version) < 0 || Number(payload.kwkId) < 1) return null;
    return { kwkId: payload.kwkId as number, sessionVersion: version as number };
  } catch {
    return null;
  }
}

/** Use this, not signature-only verification, for productive authorization. */
export async function getAuthenticatedKwkFromToken(token: string, executor?: Pick<Pool, "query">): Promise<{ kwkId: number; sessionVersion: number } | null> {
  const payload = verifyKwkToken(token);
  if (!payload) return null;
  const pool = executor || await getPool();
  if (!pool) return null;
  const result = await pool.query("SELECT id FROM kwk_accounts WHERE id = $1 AND session_version = $2 AND status = 'aktiv' AND deleted_at IS NULL LIMIT 1", [payload.kwkId, payload.sessionVersion]);
  return result.rows.length === 1 ? payload : null;
}

/**
 * Demo credentials are deliberately a different JWT subject/type. Production
 * KWK middleware accepts only `type: kwk`, so a demo session can never be used
 * for referrals, checkout credit or any productive KWK operation.
 */
export function createKwkDemoToken(demoAccountId: number): string {
  return jwt.sign(
    { demoAccountId, type: "kwk_demo" },
    getKwkDemoSigningKey(),
    {
      expiresIn: KWK_TOKEN_EXPIRY,
      audience: KWK_DEMO_AUDIENCE,
      issuer: KWK_DEMO_ISSUER,
      subject: `demo:${demoAccountId}`,
    },
  );
}

export function verifyKwkDemoToken(token: string): { demoAccountId: number } | null {
  try {
    const payload = jwt.verify(token, getKwkDemoSigningKey(), {
      audience: KWK_DEMO_AUDIENCE,
      issuer: KWK_DEMO_ISSUER,
    }) as { demoAccountId?: unknown; type?: unknown };
    if (payload.type !== "kwk_demo" || !Number.isInteger(payload.demoAccountId)) return null;
    return { demoAccountId: payload.demoAccountId as number };
  } catch {
    return null;
  }
}
