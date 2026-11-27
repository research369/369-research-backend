import { createHash, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";

export const PRECISION_COMMERCE_HEADER = "x-369-precision-commerce-key";
export const PRECISION_COMMERCE_POLICY = "precision-13cartridge-7nasal-bac10-v1";
export type PrecisionShopPrincipal = Readonly<{ storeIdentity: "precision-shop"; policy: typeof PRECISION_COMMERCE_POLICY }>;
const principal: PrecisionShopPrincipal = Object.freeze({ storeIdentity: "precision-shop", policy: PRECISION_COMMERCE_POLICY });
const validKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);

/** Only the trusted server gateway may claim this scope. Origin/storeKey are not credentials.
 * Missing header preserves every historical flow. Any attempted invalid claim is rejected,
 * including disabled/misconfigured deployments and duplicate header representations. */
export function resolvePrecisionShopPrincipal(
  req: { headers: Record<string, unknown>; rawHeaders?: string[] },
  env: Record<string, string | undefined> = process.env,
): PrecisionShopPrincipal | undefined {
  if (["x-369-precision-commerce-scope", "x-369-precision-shop", "x-precision-shop-principal"].some(h => req.headers[h] !== undefined)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "PRECISION_COMMERCE_SCOPE_CLAIM_INVALID" });
  }
  const provided = req.headers[PRECISION_COMMERCE_HEADER];
  if (provided === undefined) return undefined;
  const expected = env.PRECISION_COMMERCE_GATEWAY_KEY;
  const occurrences = req.rawHeaders?.filter((_, n) => n % 2 === 0 && req.rawHeaders![n].toLowerCase() === PRECISION_COMMERCE_HEADER).length;
  if (env.PRECISION_COMMERCE_ENABLED !== "true" || !validKey(expected) || !validKey(provided) || (occurrences !== undefined && occurrences !== 1)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "PRECISION_COMMERCE_GATEWAY_UNAUTHORIZED" });
  }
  // Equal-length digests avoid variable-length comparisons and never log key material.
  if (!timingSafeEqual(createHash("sha256").update(expected).digest(), createHash("sha256").update(provided).digest())) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "PRECISION_COMMERCE_GATEWAY_UNAUTHORIZED" });
  }
  return principal;
}

/** Bind the existing opaque intent and original payload digest to the server-owned scope.
 * The gateway/browser computes the existing checkoutFingerprint, never this scope binding. */
export function precisionReceiptFingerprint(payloadFingerprint: string): string {
  return createHash("sha256").update(`${PRECISION_COMMERCE_POLICY}:precision-shop:${payloadFingerprint}`).digest("hex");
}
