import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { shopSettings } from "../drizzle/schema.js";

/**
 * Zentrale, zeitlich begrenzte Aktion ohne Code. Die Konfiguration liegt bewusst
 * ausschließlich in shop_settings und wird sowohl im Shop als auch in der
 * serverseitigen Bestellvalidierung aus derselben Quelle gelesen.
 */
export const GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY = "global_automatic_discount";

export const globalAutomaticDiscountRegionSchema = z.enum(["de", "eu", "ch"]);
export type GlobalAutomaticDiscountRegion = z.infer<typeof globalAutomaticDiscountRegionSchema>;

const percentageSchema = z.number().finite().min(0).max(100);
const moneySchema = z.number().finite().min(0);
const isoDateTimeSchema = z.string().datetime();

/**
 * The stored format deliberately supplies defaults for fields introduced after
 * the original discount launch. Legacy records therefore keep their former
 * behavior: no global free shipping and all combinations allowed.
 */
export const globalAutomaticDiscountConfigSchema = z.object({
  enabled: z.boolean(),
  percentage: percentageSchema,
  startsAt: isoDateTimeSchema.nullable().default(null),
  expiresAt: isoDateTimeSchema.nullable(),
  freeShippingEnabled: z.boolean().default(false),
  freeShippingMinOrder: moneySchema.default(0),
  freeShippingRegions: z.array(globalAutomaticDiscountRegionSchema).default([]),
  stackWithPromotionCodes: z.boolean().default(true),
  stackWithPartnerCreatorCodes: z.boolean().default(true),
  stackWithKwk: z.boolean().default(true),
  labelDe: z.string().trim().min(1).max(120),
  labelEn: z.string().trim().min(1).max(120),
});

export type GlobalAutomaticDiscountConfig = z.infer<typeof globalAutomaticDiscountConfigSchema>;

/**
 * Public/admin editing contract. New fields are optional here so older admin
 * clients cannot accidentally invalidate an existing configuration; after the
 * merge with the stored configuration all invariants are checked centrally.
 */
export const globalAutomaticDiscountConfigInputSchema = z.object({
  enabled: z.boolean(),
  percentage: percentageSchema,
  startsAt: isoDateTimeSchema.nullable().optional(),
  expiresAt: isoDateTimeSchema.nullable(),
  stackWithPromotionCodes: z.boolean(),
  freeShippingEnabled: z.boolean().optional(),
  freeShippingMinOrder: moneySchema.optional(),
  freeShippingRegions: z.array(globalAutomaticDiscountRegionSchema).optional(),
  stackWithPartnerCreatorCodes: z.boolean().optional(),
  stackWithKwk: z.boolean().optional(),
}).strict();

export type GlobalAutomaticDiscountConfigInput = z.infer<typeof globalAutomaticDiscountConfigInputSchema>;

export type ActiveGlobalAutomaticDiscount = {
  percentage: number;
  freeShippingEnabled: boolean;
  freeShippingMinOrder: number;
  freeShippingRegions: GlobalAutomaticDiscountRegion[];
  stackWithPromotionCodes: boolean;
  stackWithPartnerCreatorCodes: boolean;
  stackWithKwk: boolean;
  labelDe: string;
  labelEn: string;
  expiresAt: string;
};

export type GlobalAutomaticDiscountEligibilityFacts = {
  /** Merchandise subtotal before any discount; shipping is intentionally excluded. */
  merchandiseSubtotal: number;
  shippingRegion?: GlobalAutomaticDiscountRegion | null;
  hasPromotionCode?: boolean;
  hasPartnerCreatorCode?: boolean;
  hasKwk?: boolean;
};

export type GlobalAutomaticDiscountResolution = {
  globalDiscountApplies: boolean;
  globalFreeShippingApplies: boolean;
};

export const defaultGlobalAutomaticDiscountConfig: GlobalAutomaticDiscountConfig = {
  enabled: false,
  percentage: 0,
  startsAt: null,
  expiresAt: null,
  freeShippingEnabled: false,
  freeShippingMinOrder: 0,
  freeShippingRegions: [],
  stackWithPromotionCodes: true,
  stackWithPartnerCreatorCodes: true,
  stackWithKwk: true,
  labelDe: "Dauerrabatt",
  labelEn: "Automatic discount",
};

/**
 * Structural rules used while parsing persisted JSON. They deliberately do not
 * require a future expiry: an expired persisted campaign must remain readable
 * by an administrator, but is never active. A missing expiry on an enabled
 * record fails closed instead.
 */
function hasValidStoredConfiguration(config: GlobalAutomaticDiscountConfig): boolean {
  if (config.enabled && !config.expiresAt) return false;
  if (config.startsAt && config.expiresAt
    && Date.parse(config.startsAt) >= Date.parse(config.expiresAt)) return false;
  if (config.freeShippingEnabled
    && (config.freeShippingMinOrder < 0 || config.freeShippingRegions.length === 0)) return false;
  return true;
}

/**
 * Enforces all admin write invariants after an edit request has been merged
 * with the stored configuration. The expiration is required and must be future
 * only when a campaign is enabled.
 */
export function assertGlobalAutomaticDiscountConfigCanBeSaved(
  config: GlobalAutomaticDiscountConfig,
  now = new Date(),
): void {
  if (!hasValidStoredConfiguration(config)) {
    if (config.enabled && !config.expiresAt) {
      throw new Error("Für einen aktiven Dauerrabatt ist ein Endzeitpunkt erforderlich");
    }
    if (config.startsAt && config.expiresAt
      && Date.parse(config.startsAt) >= Date.parse(config.expiresAt)) {
      throw new Error("Der Startzeitpunkt muss vor dem Endzeitpunkt liegen");
    }
    if (config.freeShippingEnabled && config.freeShippingRegions.length === 0) {
      throw new Error("Für kostenlosen Versand muss mindestens eine Versandregion gewählt werden");
    }
    throw new Error("Ungültige Konfiguration für kostenlosen Versand");
  }
  if (config.enabled && (!config.expiresAt || Date.parse(config.expiresAt) <= now.getTime())) {
    throw new Error("Der Endzeitpunkt muss in der Zukunft liegen");
  }
}

export function parseGlobalAutomaticDiscountConfig(value?: string | null): GlobalAutomaticDiscountConfig {
  if (!value) return defaultGlobalAutomaticDiscountConfig;
  try {
    const parsed = globalAutomaticDiscountConfigSchema.parse(JSON.parse(value));
    return hasValidStoredConfiguration(parsed) ? parsed : defaultGlobalAutomaticDiscountConfig;
  } catch {
    return defaultGlobalAutomaticDiscountConfig;
  }
}

/**
 * Resolves the two global benefits from server-owned eligibility facts. A
 * configured non-stacking explicit benefit wins; no promotion/partner/KWK code
 * is changed or invalidated by this resolver.
 */
export function resolveGlobalAutomaticDiscountBenefits(
  activeConfig: ActiveGlobalAutomaticDiscount | null,
  facts: GlobalAutomaticDiscountEligibilityFacts,
): GlobalAutomaticDiscountResolution {
  if (!activeConfig) {
    return { globalDiscountApplies: false, globalFreeShippingApplies: false };
  }

  const blockedByExplicitBenefit = Boolean(
    (facts.hasPromotionCode && !activeConfig.stackWithPromotionCodes)
    || (facts.hasPartnerCreatorCode && !activeConfig.stackWithPartnerCreatorCodes)
    || (facts.hasKwk && !activeConfig.stackWithKwk),
  );
  if (blockedByExplicitBenefit) {
    return { globalDiscountApplies: false, globalFreeShippingApplies: false };
  }

  const merchandiseSubtotal = Number.isFinite(facts.merchandiseSubtotal)
    ? Math.max(0, facts.merchandiseSubtotal)
    : 0;
  return {
    globalDiscountApplies: activeConfig.percentage > 0,
    globalFreeShippingApplies: activeConfig.freeShippingEnabled
      && merchandiseSubtotal >= activeConfig.freeShippingMinOrder
      && Boolean(facts.shippingRegion && activeConfig.freeShippingRegions.includes(facts.shippingRegion)),
  };
}

export function getActiveGlobalAutomaticDiscount(
  config: GlobalAutomaticDiscountConfig,
  now = new Date(),
): ActiveGlobalAutomaticDiscount | null {
  // This also guards direct callers that did not receive their config via the
  // defensive parser.
  if (!hasValidStoredConfiguration(config) || !config.enabled || !config.expiresAt) return null;
  if (config.startsAt && new Date(config.startsAt).getTime() > now.getTime()) return null;
  if (new Date(config.expiresAt).getTime() <= now.getTime()) return null;
  if (config.percentage <= 0 && !config.freeShippingEnabled) return null;
  return {
    percentage: config.percentage,
    freeShippingEnabled: config.freeShippingEnabled,
    freeShippingMinOrder: config.freeShippingMinOrder,
    freeShippingRegions: config.freeShippingRegions,
    stackWithPromotionCodes: config.stackWithPromotionCodes,
    stackWithPartnerCreatorCodes: config.stackWithPartnerCreatorCodes,
    stackWithKwk: config.stackWithKwk,
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
  assertGlobalAutomaticDiscountConfigCanBeSaved(input);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('global_automatic_discount'))`);
    const value = JSON.stringify(input);
    const [existing] = await tx.select().from(shopSettings)
      .where(eq(shopSettings.key, GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY))
      .limit(1);

    if (existing) {
      await tx.update(shopSettings).set({ value, updatedAt: new Date() })
        .where(eq(shopSettings.key, GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY));
    } else {
      await tx.insert(shopSettings).values({ key: GLOBAL_AUTOMATIC_DISCOUNT_CONFIG_KEY, value });
    }
    return input;
  });
}
