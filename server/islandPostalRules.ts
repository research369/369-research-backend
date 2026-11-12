import { REVIEWED_ISLAND_POSTAL_DATA } from "./islandPostalData.js";

export type IslandPostalRule = {
  id: string;
  country: string;
  kind: "exact" | "prefix" | "range";
  value: string;
  end?: string;
  label: string;
  sources: readonly string[];
  reviewedAt: string;
};

// Only independently reviewed, island-only postal jurisdictions belong here.
// Missing rules are NOT mainland proof, and mixed mainland/island areas must not
// be inserted. This is a staged extension, never a complete worldwide dataset.
export const REVIEWED_ISLAND_POSTAL_RULES: readonly IslandPostalRule[] = REVIEWED_ISLAND_POSTAL_DATA;

/** Only normalize documented postal punctuation, never truncate or strip text. */
export function normalizeIslandPostal(country: string, input: unknown): string | null {
  if (typeof input !== "string" || input.length > 20) return null;
  const value = input.trim().replace(/ /g, "");
  if (["DE", "ES", "FR", "IT"].includes(country)) return /^\d{5}$/.test(value) ? value : null;
  if (country === "PT") {
    const match = /^(\d{4})[- ](\d{3})$/.exec(value);
    return match ? match[1] + match[2] : /^\d{7}$/.test(value) ? value : null;
  }
  return null;
}

export function findIslandPostalRule(country: string, postal: unknown, rules: readonly IslandPostalRule[] = REVIEWED_ISLAND_POSTAL_RULES): IslandPostalRule | null {
  const normalized = normalizeIslandPostal(country, postal);
  if (!normalized) return null;
  return rules.find(rule => {
    if (rule.country !== country || !rule.sources.length || !/^\d+$/.test(rule.value)) return false;
    if (rule.kind === "exact") return normalized === rule.value;
    if (rule.kind === "prefix") return normalized.startsWith(rule.value);
    return !!rule.end && rule.value.length === normalized.length && rule.end.length === normalized.length
      && /^\d+$/.test(rule.end) && rule.end >= rule.value && normalized >= rule.value && normalized <= rule.end;
  }) ?? null;
}
