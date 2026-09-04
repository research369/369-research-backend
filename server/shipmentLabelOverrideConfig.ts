import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { shopSettings } from "../drizzle/schema.js";

export const PACKING_AUTOMATION_CONFIG_KEY = "packing_automation_config";

export const shipmentLabelOverrideConfigSchema = z.object({
  enabled: z.boolean(),
  allowedRoles: z.array(z.enum(["admin"])).min(1),
  allowedWarningCodes: z.array(z.enum(["zip_city_mismatch", "provider_unavailable"])).min(1),
  requireServerConfirmedPackingPhoto: z.boolean(),
  requireCompletePackingChecklist: z.boolean(),
});

export type ShipmentLabelOverrideConfig = z.infer<typeof shipmentLabelOverrideConfigSchema>;

export const DEFAULT_SHIPMENT_LABEL_OVERRIDE_CONFIG: ShipmentLabelOverrideConfig = {
  enabled: true,
  allowedRoles: ["admin"],
  allowedWarningCodes: ["zip_city_mismatch", "provider_unavailable"],
  requireServerConfirmedPackingPhoto: true,
  requireCompletePackingChecklist: true,
};

/** Adds the centrally stored override configuration exactly once without touching other packing settings. */
export async function ensureShipmentLabelOverrideConfig(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Datenbank für DHL-Label-Override nicht verfügbar");
  const [setting] = await db.select().from(shopSettings)
    .where(eq(shopSettings.key, PACKING_AUTOMATION_CONFIG_KEY))
    .limit(1);
  if (!setting?.value) throw new Error("Packautomationskonfiguration nicht vorhanden");

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(setting.value) as Record<string, unknown>;
  } catch {
    throw new Error("Packautomationskonfiguration ist nicht lesbar");
  }
  if (config.manualLabelOverride) {
    shipmentLabelOverrideConfigSchema.parse(config.manualLabelOverride);
    return;
  }
  await db.update(shopSettings).set({
    value: JSON.stringify({ ...config, manualLabelOverride: DEFAULT_SHIPMENT_LABEL_OVERRIDE_CONFIG }),
    updatedAt: new Date(),
  }).where(eq(shopSettings.key, PACKING_AUTOMATION_CONFIG_KEY));
}

export async function getShipmentLabelOverrideConfig(): Promise<ShipmentLabelOverrideConfig> {
  const db = await getDb();
  if (!db) throw new Error("Datenbank für DHL-Label-Override nicht verfügbar");
  const [setting] = await db.select().from(shopSettings)
    .where(eq(shopSettings.key, PACKING_AUTOMATION_CONFIG_KEY))
    .limit(1);
  if (!setting?.value) throw new Error("Packautomationskonfiguration nicht vorhanden");

  let value: unknown;
  try {
    value = JSON.parse(setting.value);
  } catch {
    throw new Error("Packautomationskonfiguration ist nicht lesbar");
  }
  const overrideConfig = (value as Record<string, unknown>).manualLabelOverride;
  return shipmentLabelOverrideConfigSchema.parse(overrideConfig);
}

export function canOverrideShipmentWarning(
  config: ShipmentLabelOverrideConfig,
  role: string | null | undefined,
  warningCodes: string[],
): boolean {
  return config.enabled
    && !!role
    && config.allowedRoles.includes(role as "admin")
    && warningCodes.length > 0
    && warningCodes.every((code) => config.allowedWarningCodes.includes(code as "zip_city_mismatch" | "provider_unavailable"));
}
