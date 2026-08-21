/**
 * Shop Settings Router – tRPC routes for global shop configuration
 * 
 * Key settings:
 * - shop_open: Master toggle to enable/disable the entire shop
 *   When false, all products show "Out of Stock – Bitte per WhatsApp anfragen"
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, publicProcedure, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { shopSettings } from "../drizzle/schema.js";

const WHATSAPP_CHANNEL_CONFIG_KEY = "whatsapp_channel_config";

const whatsappChannelConfigSchema = z.object({
  enabled: z.boolean(),
  channelUrl: z.string().url(),
  titleDe: z.string().min(1).max(160),
  titleEn: z.string().min(1).max(160),
  descriptionDe: z.string().min(1).max(500),
  descriptionEn: z.string().min(1).max(500),
  buttonLabelDe: z.string().min(1).max(80),
  buttonLabelEn: z.string().min(1).max(80),
  ruoNoteDe: z.string().max(160),
  ruoNoteEn: z.string().max(160),
  placements: z.array(z.enum(["home", "product", "checkout", "confirmation", "calculator"])).min(1),
});

type WhatsAppChannelConfig = z.infer<typeof whatsappChannelConfigSchema>;

function parseWhatsAppChannelConfig(value: string | undefined): WhatsAppChannelConfig | null {
  if (!value) return null;
  try {
    return whatsappChannelConfigSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export const shopSettingsRouter = router({
  // ─── PUBLIC: WhatsApp channel conversion configuration ────────
  getWhatsAppChannelConfig: publicProcedure
    .query(async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [setting] = await db.select().from(shopSettings)
        .where(eq(shopSettings.key, WHATSAPP_CHANNEL_CONFIG_KEY))
        .limit(1);
      return { config: parseWhatsAppChannelConfig(setting?.value) };
    }),

  // ─── ADMIN: WhatsApp channel conversion configuration ─────────
  setWhatsAppChannelConfig: adminProcedure
    .input(whatsappChannelConfigSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const serialized = JSON.stringify(input);
      const existing = await db.select().from(shopSettings)
        .where(eq(shopSettings.key, WHATSAPP_CHANNEL_CONFIG_KEY))
        .limit(1);
      if (existing.length > 0) {
        await db.update(shopSettings).set({ value: serialized, updatedAt: new Date() })
          .where(eq(shopSettings.key, WHATSAPP_CHANNEL_CONFIG_KEY));
      } else {
        await db.insert(shopSettings).values({ key: WHATSAPP_CHANNEL_CONFIG_KEY, value: serialized });
      }
      return { success: true, config: input };
    }),

  // ─── PUBLIC: Check if shop is open ────────────────────────────
  getShopStatus: publicProcedure
    .query(async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [setting] = await db.select().from(shopSettings)
        .where(eq(shopSettings.key, "shop_open"))
        .limit(1);

      return {
        shopOpen: setting ? setting.value === "true" : true,
        updatedAt: setting?.updatedAt || null,
      };
    }),

  // ─── ADMIN: Toggle shop open/closed ───────────────────────────
  toggleShop: adminProcedure
    .input(z.object({ open: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const value = input.open ? "true" : "false";

      // Upsert the setting
      const existing = await db.select().from(shopSettings)
        .where(eq(shopSettings.key, "shop_open"))
        .limit(1);

      if (existing.length > 0) {
        await db.update(shopSettings).set({
          value,
          updatedAt: new Date(),
        }).where(eq(shopSettings.key, "shop_open"));
      } else {
        await db.insert(shopSettings).values({
          key: "shop_open",
          value,
        });
      }

      console.log(`[ShopSettings] Shop ${input.open ? "OPENED" : "CLOSED (Out of Stock)"}`);
      return { success: true, shopOpen: input.open };
    }),

  // ─── ADMIN: Get all settings ──────────────────────────────────
  getAll: adminProcedure
    .query(async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const all = await db.select().from(shopSettings);
      return all;
    }),

  // ─── PUBLIC: Get 2-for-3 promo status ─────────────────────────
  // Returns current state of the 2-buy-3-get promotion
  getPromo2for3: publicProcedure
    .query(async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const rows = await db.select().from(shopSettings)
        .where(eq(shopSettings.key, "promo_2for3_enabled"));
      const expiresRow = await db.select().from(shopSettings)
        .where(eq(shopSettings.key, "promo_2for3_expires_at"));
      const modeRow = await db.select().from(shopSettings)
        .where(eq(shopSettings.key, "promo_2for3_mode"));
      const productsRow = await db.select().from(shopSettings)
        .where(eq(shopSettings.key, "promo_2for3_products"));

      const rawEnabled = rows[0]?.value === "true";
      const expiresAt = expiresRow[0]?.value || null;
      const mode = (modeRow[0]?.value as "all" | "include" | "exclude") || "all";
      const products: string[] = JSON.parse(productsRow[0]?.value || "[]");

      // Auto-expire: if expiresAt is set and in the past, treat as disabled
      let enabled = rawEnabled;
      if (enabled && expiresAt) {
        const expires = new Date(expiresAt);
        if (!isNaN(expires.getTime()) && expires < new Date()) {
          enabled = false;
          // Auto-disable in DB
          await db.update(shopSettings).set({ value: "false", updatedAt: new Date() })
            .where(eq(shopSettings.key, "promo_2for3_enabled"));
        }
      }

      const remainingSeconds = enabled && expiresAt
        ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
        : null;

      return { enabled, expiresAt, remainingSeconds, mode, products };
    }),

  // ─── ADMIN: Set 2-for-3 promo ────────────────────────────────────
  // Activate/deactivate the promotion with optional duration and product filter
  setPromo2for3: adminProcedure
    .input(z.object({
      enabled: z.boolean(),
      durationHours: z.number().optional(),    // if set: expiresAt = now + durationHours
      expiresAt: z.string().optional(),        // ISO string, alternative to durationHours
      mode: z.enum(["all", "include", "exclude"]).optional(),
      products: z.array(z.string()).optional(), // product IDs for include/exclude
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const upsert = async (key: string, value: string) => {
        const existing = await db.select().from(shopSettings).where(eq(shopSettings.key, key)).limit(1);
        if (existing.length > 0) {
          await db.update(shopSettings).set({ value, updatedAt: new Date() }).where(eq(shopSettings.key, key));
        } else {
          await db.insert(shopSettings).values({ key, value });
        }
      };

      await upsert("promo_2for3_enabled", input.enabled ? "true" : "false");

      if (input.enabled) {
        // Calculate expiresAt
        let expiresAt = "";
        if (input.expiresAt) {
          expiresAt = input.expiresAt;
        } else if (input.durationHours && input.durationHours > 0) {
          const exp = new Date(Date.now() + input.durationHours * 3600 * 1000);
          expiresAt = exp.toISOString();
        }
        await upsert("promo_2for3_expires_at", expiresAt);
      } else {
        await upsert("promo_2for3_expires_at", "");
      }

      if (input.mode !== undefined) await upsert("promo_2for3_mode", input.mode);
      if (input.products !== undefined) await upsert("promo_2for3_products", JSON.stringify(input.products));

      console.log(`[ShopSettings] 2for3 Promo ${input.enabled ? "ACTIVATED" : "DEACTIVATED"}`);
      return { success: true };
    }),

  // ─── ADMIN: Set any setting ───────────────────────────────────
  set: adminProcedure
    .input(z.object({ key: z.string(), value: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const existing = await db.select().from(shopSettings)
        .where(eq(shopSettings.key, input.key))
        .limit(1);

      if (existing.length > 0) {
        await db.update(shopSettings).set({
          value: input.value,
          updatedAt: new Date(),
        }).where(eq(shopSettings.key, input.key));
      } else {
        await db.insert(shopSettings).values({
          key: input.key,
          value: input.value,
        });
      }

      return { success: true };
    }),
});
