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

export const shopSettingsRouter = router({
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
