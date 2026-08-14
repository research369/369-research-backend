/**
 * Zentraler Vertrag für das 369 DIY-Nasenspray-Set.
 *
 * Der Standardpreis der hier genannten Produkte bezieht sich ausschließlich
 * auf das Vial. Das Set ist eine optionale Ergänzung und kein fertiges Nasenspray.
 * Diese Datei ist die serverseitige Quelle für validierte Bestellpositionen und
 * den Lieferumfang. Änderungen müssen mit client/src/lib/plugPlayConfig.ts
 * abgestimmt werden, damit Shop und WaWi dieselben Regeln anzeigen.
 */
export const NASAL_DIY_SET_SURCHARGE = 7;

export const NASAL_DIY_SET_ELIGIBLE_PRODUCT_IDS = new Set([
  "semax",
  "selank",
  "adamax",
  "oxytocin",
  "pt-141",
  "kisspeptin-10",
]);

export const NASAL_DIY_SET_COMPONENTS = [
  {
    name: "DIY Nasenspray-Set · BAC Wasser 10 ml",
    variant: "10 ml · enthalten",
    articleShopProductId: "bac-wasser",
    inventoryTracked: true,
  },
  {
    name: "DIY Nasenspray-Set · Leere Nasensprayflasche",
    variant: "enthalten",
    inventoryTracked: false,
  },
  {
    name: "DIY Nasenspray-Set · 10-ml-Aufziehspritze + Kanüle",
    variant: "enthalten",
    inventoryTracked: false,
  },
] as const;

export function isNasalDiySetEligible(shopProductId?: string | null): boolean {
  return !!shopProductId && NASAL_DIY_SET_ELIGIBLE_PRODUCT_IDS.has(shopProductId);
}
