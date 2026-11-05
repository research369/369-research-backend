import jwt from "jsonwebtoken";
import { createHmac } from "node:crypto";
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

export function createKwkToken(kwkId: number): string {
  return jwt.sign({ kwkId, type: "kwk" }, ENV.jwtSecret, { expiresIn: KWK_TOKEN_EXPIRY });
}

export function verifyKwkToken(token: string): { kwkId: number } | null {
  try {
    const payload = jwt.verify(token, ENV.jwtSecret) as { kwkId?: unknown; type?: unknown };
    if (payload.type !== "kwk" || !Number.isInteger(payload.kwkId)) return null;
    return { kwkId: payload.kwkId as number };
  } catch {
    return null;
  }
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
