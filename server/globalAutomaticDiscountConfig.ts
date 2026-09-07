import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { shopSettings } from "../drizzle/schema.js";

/**
 * Zentrale, zeitlich begrenzte Aktion ohne Code. Die Konfiguration liegt bewusst
 * ausschließlich in shop_settings und wird sowohl im Shop als auch in der
 * serverseitigen Bestellvalidierung aus derselben Quelle gelesen.
 */
export const GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY = "global_automatic_discount";

export const globalAutomaticDiscountConfigSchema = z.object({
  enabled: z.boolean(),
  percentage: z.number().min(0).max(100),
  expiresAt: z.string().datetime().nullable(),
  stackWithPromotionCodes: z.boolean(),
  labelDe: z.string().trim().min(1).max(120),
  labelEn: z.string().trim().min(1).max(120),
});

export type GlobalAutomaticDiscountConfig = z.infer<typeof globalAutomaticDiscountConfigSchema>;

export type ActiveGlobalAutomaticDiscount = {
  percentage: number;
  stackWithPromotionCodes: boolean;
  labelDe: string;
  labelEn: string;
  expiresAt: string | null;
};

export const defaultGlobalAutomaticDiscountConfig: GlobalAutomaticDiscountConfig = {
  enabled: false,
  percentage: 0,
  expiresAt: null,
  stackWithPromotionCodes: true,
  labelDe: "Dauerrabatt",
  labelEn: "Automatic discount",
};

export function parseGlobalAutomaticDiscountConfig(value?: string | null): GlobalAutomaticDiscountConfig {
  if (!value) return defaultGlobalAutomaticDiscountConfig;
  try {
    return globalAutomaticDiscountConfigSchema.parse(JSON.parse(value));
  } catch {
    return defaultGlobalAutomaticDiscountConfig;
  }
}

export function getActiveGlobalAutomaticDiscount(config: GlobalAutomaticDiscountConfig, now = new Date()): ActiveGlobalAutomaticDiscount | null {
  if (!config.enabled || config.percentage <= 0) return null;
  if (config.expiresAt && new Date(config.expiresAt).getTime() <= now.getTime()) return null;
  return {
    percentage: config.percentage,
    stackWithPromotionCodes: config.stackWithPromotionCodes,
    labelDe: config.labelDe,
    labelEn: config.labelEn,
    expiresAt: config.expiresAt,
  };
}

export async function getGlobalAutomaticDiscountConfig(): Promise<GlobalAutomaticDiscountConfig> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [setting] = await db.select().from(shopSettings)
    .where(eq(shopSettings.key, GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY))
    .limit(1);
  return parseGlobalAutomaticDiscountConfig(setting?.value);
}

export async function getActiveGlobalAutomaticDiscountFromDb(): Promise<ActiveGlobalAutomaticDiscount | null> {
  return getActiveGlobalAutomaticDiscount(await getGlobalAutomaticDiscountConfig());
}

export async function upsertGlobalAutomaticDiscountConfig(input: GlobalAutomaticDiscountConfig) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const value = JSON.stringify(input);
  const [existing] = await db.select().from(shopSettings)
    .where(eq(shopSettings.key, GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY))
    .limit(1);

  if (existing) {
    await db.update(shopSettings).set({ value, updatedAt: new Date() })
      .where(eq(shopSettings.key, GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY));
  } else {
    await db.insert(shopSettings).values({ key: GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY, value });
  }
  return input;
}
