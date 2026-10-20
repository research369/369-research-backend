import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
export const promotionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z
    .object({
      mode: z.literal("explicit_code"),
      code: z
        .string()
        .trim()
        .min(1)
        .max(50)
        .transform((s) => s.toUpperCase()),
    })
    .strict(),
]);
const home = z
  .object({
    type: z.literal("home"),
    company: z.string().max(160).nullable().optional(),
    street: z.string().trim().min(1).max(160),
    house_number: z.string().trim().min(1).max(20),
    postal_code: z.string().trim().min(1).max(20),
    city: z.string().trim().min(1).max(100),
    country_code: z.enum(["DE", "AT", "CH", "FR", "NL", "BE", "IT", "ES"]),
  })
  .strict();
const packstation = z
  .object({
    type: z.literal("dhl_packstation"),
    packstation_number: z.string().regex(/^\d{3,6}$/),
    dhl_post_number: z.string().regex(/^\d{6,10}$/),
    postal_code: z.string().regex(/^\d{5}$/),
    city: z.string().trim().min(1).max(100),
    country_code: z.literal("DE"),
  })
  .strict();
export const quoteRequest = z
  .object({
    schema_version: z.literal("1"),
    draft_id: z.string().uuid(),
    bot_conversation_id: z.string().min(8).max(160),
    customer: z
      .object({
        first_name: z.string().trim().min(1).max(80),
        last_name: z.string().trim().min(1).max(80),
        email: z.string().email().max(254).optional(),
        phone: z
          .string()
          .regex(/^\+[1-9]\d{7,14}$/)
          .optional(),
        language: z.enum(["de", "en"]),
      })
      .strict()
      .refine((c) => !!(c.email || c.phone), "missing_contact"),
    delivery: z.discriminatedUnion("type", [home, packstation]),
    lines: z
      .array(
        z
          .object({
            catalog_item_id: z.string().min(10).max(1500),
            quantity: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    promotion: promotionSchema,
    payment_method: z.literal("bank_transfer"),
    customer_note: z.string().max(1000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.lines.map((l) => l.catalog_item_id)).size === v.lines.length,
    "duplicate_catalog_item",
  );
export type QuoteRequest = z.infer<typeof quoteRequest>;
export const executeRequest = z
  .object({
    execution_id: z.string().uuid(),
    quote_id: z.string().uuid(),
    quote_hash: z.string().regex(/^[a-f0-9]{64}$/),
    quote_revision: z.number().int().positive(),
    customer_confirmation: z
      .object({
        confirmation_challenge_id: z.string().uuid(),
        message_id: z.string().min(1).max(160),
        confirmed_at: z.string().datetime(),
      })
      .strict(),
    owner_approval: z
      .object({ approval_token: z.string().min(32).max(200) })
      .strict(),
  })
  .strict();
export const catalogSearch = z
  .object({
    query: z.string().trim().min(2).max(200),
    locale: z.enum(["de", "en"]),
    limit: z.number().int().min(1).max(10).default(10),
  })
  .strict();
export function signCatalog(sku: string, secret: string) {
  const data = Buffer.from(JSON.stringify({ v: 1, sku })).toString("base64url");
  return (
    "woc_" +
    data +
    "." +
    createHmac("sha256", secret).update(data).digest("base64url")
  );
}
export function verifyCatalog(ref: string, secret: string): string {
  const [data, signature] = ref.replace(/^woc_/, "").split(".");
  const expected = createHmac("sha256", secret)
    .update(data || "")
    .digest("base64url");
  if (
    !signature ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    throw Error("invalid_catalog_item");
  const value = JSON.parse(Buffer.from(data, "base64url").toString());
  if (value.v !== 1 || typeof value.sku !== "string")
    throw Error("invalid_catalog_item");
  return value.sku;
}
