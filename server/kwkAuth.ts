import jwt from "jsonwebtoken";
import { ENV } from "./env.js";

const KWK_TOKEN_EXPIRY = "30d";

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
