import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { shopSettings } from "../drizzle/schema.js";
import {
  defaultGlobalAutomaticDiscountConfig,
  globalAutomaticDiscountConfigSchema,
  assertGlobalAutomaticDiscountConfigCanBeSaved,
} from "./globalAutomaticDiscountConfig.js";

export const GLOBAL_AUTOMATIC_DISCOUNT_PRESETS_KEY = "global_automatic_discount_presets";
export const BLACK_FRIDAY_PRESET_ID = "black-friday-36-9";

export const promotionPresetSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(80),
  name: z.string().trim().min(1).max(120),
  config: globalAutomaticDiscountConfigSchema.extend({ enabled: z.literal(false) }),
}).strict().superRefine((preset, ctx) => {
  if (preset.id === BLACK_FRIDAY_PRESET_ID && (!preset.config.exclusiveCampaign
    || !preset.config.freeBacWaterPerPaidVial || preset.config.stackWithPromotionCodes
    || preset.config.stackWithPartnerCreatorCodes || preset.config.stackWithKwk)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Black Friday bleibt exklusiv, ohne Codes/KWK und mit BAC pro bezahltem Vial" });
  }
});
export type PromotionPreset = z.infer<typeof promotionPresetSchema>;
const presetsStoreSchema = z.object({ version: z.literal(1), presets: z.array(promotionPresetSchema).max(100) });

/** Available without any seed write. Never enabled/activated by reading/selecting. */
export function getBuiltInBlackFridayPreset(): PromotionPreset {
  return {
    id: BLACK_FRIDAY_PRESET_ID,
    name: "Black Friday36.9",
    config: {
      ...defaultGlobalAutomaticDiscountConfig,
      enabled: false,
      percentage: 36.9,
      startsAt: "2026-11-12T23:00:00.000Z",
      expiresAt: "2026-11-13T23:00:00.000Z",
      freeShippingEnabled: true,
      freeShippingMinOrder: 150,
      freeShippingRegions: ["de", "eu", "ch"],
      stackWithPromotionCodes: false,
      stackWithPartnerCreatorCodes: false,
      stackWithKwk: false,
      exclusiveCampaign: true,
      coldShippingSurcharge: 15,
      freeBacWaterPerPaidVial: true,
      labelDe: "Black Friday36.9",
      labelEn: "Black Friday36.9",
    },
  };
}

export function parsePromotionPresets(value?: string | null): PromotionPreset[] {
  const builtIn = getBuiltInBlackFridayPreset();
  if (!value) return [builtIn];
  try {
    const parsed = presetsStoreSchema.parse(JSON.parse(value));
    const validPresets = parsed.presets.filter((preset) => {
      try { assertGlobalAutomaticDiscountConfigCanBeSaved(preset.config); return true; } catch { return false; }
    });
    return validPresets.some((preset) => preset.id === BLACK_FRIDAY_PRESET_ID)
      ? validPresets : [builtIn, ...validPresets];
  } catch { return [builtIn]; }
}

export async function getPromotionPresets(): Promise<PromotionPreset[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [setting] = await db.select().from(shopSettings)
    .where(eq(shopSettings.key, GLOBAL_AUTOMATIC_DISCOUNT_PRESETS_KEY)).limit(1);
  return parsePromotionPresets(setting?.value);
}

export async function savePromotionPreset(input: PromotionPreset): Promise<PromotionPreset[]> {
  const preset = promotionPresetSchema.parse(input);
  assertGlobalAutomaticDiscountConfigCanBeSaved(preset.config);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('global_automatic_discount_presets'))`);
    const [existing] = await tx.select().from(shopSettings)
      .where(eq(shopSettings.key, GLOBAL_AUTOMATIC_DISCOUNT_PRESETS_KEY)).limit(1);
    const presets = parsePromotionPresets(existing?.value);
    const index = presets.findIndex((entry) => entry.id === preset.id);
    if (index < 0) presets.push(preset); else presets[index] = preset;
    const value = JSON.stringify(presetsStoreSchema.parse({ version: 1, presets }));
    if (existing) {
      await tx.update(shopSettings).set({ value, updatedAt: new Date() })
        .where(eq(shopSettings.key, GLOBAL_AUTOMATIC_DISCOUNT_PRESETS_KEY));
    } else {
      await tx.insert(shopSettings).values({ key: GLOBAL_AUTOMATIC_DISCOUNT_PRESETS_KEY, value });
    }
    return presets;
  });
}
