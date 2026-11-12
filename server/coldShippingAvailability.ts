import { COLD_SHIPPING_COUNTRIES } from "./coldShippingDestinationCountries.js";
import { findIslandPostalRule } from "./islandPostalRules.js";

export type ColdShippingAvailabilityInput = { country: string; zip: string; city: string };
export type ColdShippingAvailability = {
  eligible: boolean;
  status: "mainland" | "island" | "unknown";
  reason: string;
  policyMode: "reviewed-island-postcodes";
};
// ISO territories entirely on islands. NOT every island worldwide and NOT a
// mainland whitelist. See docs/BLACK_FRIDAY_RELEASE.md for the explicit gap.
export const ISLAND_TERRITORIES = new Set([
  "AG", "AI", "AS", "AW", "AX", "BB", "BH", "BL", "BM", "BN", "BQ", "BS",
  "BV", "CC", "CK", "CU", "CV", "CW", "CX", "CY", "DM", "DO", "FJ", "FK",
  "FM", "FO", "GB", "GD", "GG", "GL", "GP", "GS", "GU", "HM", "HT", "ID",
  "IE", "IM", "IO", "IS", "JE", "JM", "JP", "KI", "KM", "KN", "KY", "LC",
  "LK", "MF", "MG", "MH", "MP", "MQ", "MS", "MT", "MU", "MV", "NC", "NF",
  "NR", "NU", "NZ", "PF", "PG", "PH", "PM", "PN", "PR", "PW", "RE", "SB",
  "SC", "SG", "SH", "SJ", "ST", "SX", "TC", "TL", "TO", "TT", "TV", "TW",
  "UM", "VC", "VG", "VI", "VU", "WF", "WS", "YT",
]);
/**
 * Explicitly PARTIAL production stage. Whole-island territories and reviewed
 * island-only postal jurisdictions are denied. No postal centroid or coastal
 * buffer is used; mixed jurisdictions cannot be blocked by these rules.
 * Other territories retain their existing cold shipping availability; unknown
 * is not proof of mainland. Never advertise complete island-address detection.
 */
export async function getColdShippingAvailability(input: ColdShippingAvailabilityInput): Promise<ColdShippingAvailability> {
  const key = input.country.trim().normalize("NFKC").toLocaleUpperCase("de-DE").replace(/\s+/g, " ");
  const country = COLD_SHIPPING_COUNTRIES[key];
  if (country && (ISLAND_TERRITORIES.has(country) || findIslandPostalRule(country, input.zip))) {
    return {
      eligible: false, status: "island", policyMode: "reviewed-island-postcodes",
      reason: "Gekühlter Versand und kühlpflichtige Artikel sind an Inseladressen nicht möglich. Bitte entferne die betroffenen Positionen oder ändere die Lieferadresse.",
    };
  }
  return { eligible: true, status: "unknown", policyMode: "reviewed-island-postcodes", reason: "" };
}
