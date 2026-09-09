import { and, eq } from "drizzle-orm";
import { articles, shopSettings } from "../drizzle/schema.js";
import { getDb } from "./db.js";

/**
 * Versionierter, serverseitiger Vertrag für das optionale Nasenspray Kit.
 *
 * Der Produktpreis bleibt immer der Vial-Preis. Das Kit ist ein optionaler
 * Zubehörsatz, kein fertig gemischtes Nasenspray. Der Vertrag wird in
 * `shop_settings` persistiert und vom Checkout serverseitig gelesen.
 */
export const NASAL_SPRAY_KIT_CONFIG_KEY = "nasal_spray_kit_config_v2";

export type NasalSprayKitComponent = {
  name: string;
  variant: string;
  articleShopProductId?: string;
  inventoryTracked: boolean;
  quantityPerKit: number;
};

export type NasalSprayKitProductRule = {
  shopProductId: string;
  nasalKitEligible: boolean;
  injectable: boolean;
};

export type NasalSprayKitConfig = {
  version: 2;
  displayName: "Nasenspray Kit";
  surcharge: number;
  products: NasalSprayKitProductRule[];
  components: NasalSprayKitComponent[];
};

function isValidConfig(candidate: unknown): candidate is NasalSprayKitConfig {
  if (!candidate || typeof candidate !== "object") return false;
  const value = candidate as Partial<NasalSprayKitConfig>;
  if (value.version !== 2 || value.displayName !== "Nasenspray Kit") return false;
  if (typeof value.surcharge !== "number" || value.surcharge < 0 || value.surcharge > 100) return false;
  if (!Array.isArray(value.products) || !Array.isArray(value.components)) return false;
  return value.products.every((product) =>
    typeof product?.shopProductId === "string"
    && product.shopProductId.trim().length > 0
    && typeof product.nasalKitEligible === "boolean"
    && typeof product.injectable === "boolean",
  ) && value.components.every((component) =>
    typeof component?.name === "string"
    && typeof component.variant === "string"
    && typeof component.inventoryTracked === "boolean"
    && Number.isInteger(component.quantityPerKit)
    && component.quantityPerKit > 0
    && (!component.inventoryTracked || typeof component.articleShopProductId === "string"),
  );
}

/** Liest den zentralen Vertrag; ohne valide WaWi-Konfiguration bleibt das Kit gesperrt. */
export async function getNasalSprayKitConfig(): Promise<NasalSprayKitConfig> {
  const db = await getDb();
  if (!db) throw new Error("Datenbankverbindung für Nasenspray Kit nicht verfügbar");

  const [setting] = await db
    .select({ value: shopSettings.value })
    .from(shopSettings)
    .where(eq(shopSettings.key, NASAL_SPRAY_KIT_CONFIG_KEY))
    .limit(1);

  if (!setting?.value) {
    throw new Error("Nasenspray-Kit-Konfiguration fehlt");
  }
  try {
    const parsed = JSON.parse(setting.value);
    if (isValidConfig(parsed)) return parsed;
  } catch {
    // Fail closed below: invalid persisted business configuration must not permit a kit order.
  }
  throw new Error("Nasenspray-Kit-Konfiguration ist ungültig");
}

export function findNasalSprayKitRule(config: NasalSprayKitConfig, shopProductId?: string | null): NasalSprayKitProductRule | null {
  if (!shopProductId) return null;
  return config.products.find((product) => product.shopProductId === shopProductId) ?? null;
}

export function isNasalSprayKitEligible(config: NasalSprayKitConfig, shopProductId?: string | null): boolean {
  return findNasalSprayKitRule(config, shopProductId)?.nasalKitEligible === true;
}

/** Öffentliche, sichere Verfügbarkeit: Nur BAC-Wasser entscheidet über die Kit-Auswahl. */
export async function getNasalSprayKitAvailability(config?: NasalSprayKitConfig) {
  const resolvedConfig = config ?? await getNasalSprayKitConfig();
  const trackedComponent = resolvedConfig.components.find((component) => component.inventoryTracked);
  if (!trackedComponent?.articleShopProductId) {
    return { kitAvailable: false, availableUnits: 0, trackedComponent: null };
  }
  const db = await getDb();
  if (!db) throw new Error("Datenbankverbindung für Nasenspray Kit nicht verfügbar");
  const [article] = await db
    .select({ id: articles.id, stock: articles.stock, isActive: articles.isActive })
    .from(articles)
    .where(and(
      eq(articles.shopProductId, trackedComponent.articleShopProductId),
      eq(articles.isActive, 1),
    ))
    .limit(1);
  const availableUnits = article?.stock ?? 0;
  return {
    kitAvailable: availableUnits >= trackedComponent.quantityPerKit,
    availableUnits,
    trackedComponent: article ? { articleId: article.id, shopProductId: trackedComponent.articleShopProductId } : null,
  };
}
