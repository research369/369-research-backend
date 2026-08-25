/**
 * substitutionService.ts – Smart Substitution
 *
 * Wenn eine Variante ausverkauft ist, wird sie intern durch kleinere Varianten
 * desselben Produkts ersetzt. Der Kunde sieht nichts davon.
 *
 * Logik:
 * - Nur für injizierbare Peptide (Vials, Patronen, Nasensprays)
 * - Ausgeschlossen: Kapseln/Tabletten, Zubehör, Kosmetik
 * - Priorität: immer die nächstgrößere verfügbare Variante zuerst
 *   (höhere mg = günstiger im Einkauf)
 * - Kombination aus mehreren kleineren Varianten möglich
 * - Feature global ein-/ausschaltbar via substitution_config-Tabelle
 *
 * Konfiguration:
 * - Tabelle: substitution_config (id, enabled, updated_at)
 * - Nur eine Zeile (id=1), wird beim ersten Start angelegt
 *
 * Externe Agenten: Alle Logik hier, keine Hardcodes in anderen Dateien.
 */

import { getDb } from "./db.js";
import { articles, stockHistory } from "../drizzle/schema.js";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";

// ─── Kategorien die NICHT substituiert werden ──────────────────────────────────
// Pflege ausschließlich hier – gilt für alle Substitutions-Prüfungen.
export const SUBSTITUTION_EXCLUDED_CATEGORIES = [
  "Kapseln / Tabletten",
  "Tabletten",
  "Kapseln",
  "Zubehör",
  "369 BeautyLine",
  "Forscher-Bundles",
  "Fertigpens",
  "Forscherpens",
];

// ─── Typen ─────────────────────────────────────────────────────────────────────

export interface SubstitutionComponent {
  /** Artikel-ID in der DB */
  articleId: number;
  /** Artikel-Name (z.B. "BPC-157 (10 mg)") */
  articleName: string;
  /** SKU */
  sku: string;
  /** Anzahl dieser Variante die verwendet wird */
  quantity: number;
  /** Dosierung in mg (numerisch, für Sortierung) */
  dosageMg: number;
}

export interface SubstitutionResult {
  /** Ob eine Substitution gefunden wurde */
  possible: boolean;
  /** Komponenten der Substitution (z.B. [{10mg, qty:2}, {5mg, qty:1}]) */
  components: SubstitutionComponent[];
  /** Beschreibung für WaWi-interne Anzeige */
  internalNote: string;
}

// ─── Hilfsfunktionen ───────────────────────────────────────────────────────────

/**
 * Extrahiert den numerischen mg-Wert aus einem Artikelnamen.
 * Beispiele: "BPC-157 (10 mg)" → 10, "3G-TRIPLE G / R3ta (30 mg)" → 30
 */
export function extractDosageMg(name: string): number | null {
  // Muster: "(X mg)" oder "X mg" am Ende
  const match = name.match(/\((\d+(?:\.\d+)?)\s*mg\)/i)
    || name.match(/(\d+(?:\.\d+)?)\s*mg\b/i);
  if (match) return parseFloat(match[1]);
  return null;
}

/**
 * Prüft ob eine Artikelkategorie für Substitution berechtigt ist.
 * Ausgeschlossen: Kapseln, Zubehör, Kosmetik etc.
 */
export function isSubstitutionEligible(category: string | null | undefined): boolean {
  if (!category) return true; // Keine Kategorie → erlaubt (Peptide ohne Kategorie)
  return !SUBSTITUTION_EXCLUDED_CATEGORIES.includes(category);
}

// ─── Globaler Schalter ─────────────────────────────────────────────────────────

/**
 * Liest ob Smart Substitution global aktiviert ist.
 * Gibt false zurück wenn die Tabelle nicht existiert oder ein Fehler auftritt.
 */
export async function isSubstitutionEnabled(): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const result = await db.execute(
      sql`SELECT enabled FROM substitution_config WHERE id = 1 LIMIT 1`
    ) as any;
    const rows = result?.rows ?? result ?? [];
    if (!rows.length) return false;
    return rows[0].enabled === true || rows[0].enabled === 1;
  } catch {
    return false;
  }
}

/**
 * Setzt den globalen Schalter für Smart Substitution.
 */
export async function setSubstitutionEnabled(enabled: boolean): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB nicht verfügbar");
  await db.execute(
    sql`INSERT INTO substitution_config (id, enabled, updated_at)
        VALUES (1, ${enabled}, NOW())
        ON CONFLICT (id) DO UPDATE SET enabled = ${enabled}, updated_at = NOW()`
  );
}

// ─── Kern-Logik ────────────────────────────────────────────────────────────────

/**
 * Versucht eine ausverkaufte Variante durch kleinere Varianten zu ersetzen.
 *
 * Algorithmus (Greedy, größte zuerst):
 * 1. Lade alle aktiven Artikel desselben shopProductId
 * 2. Filtere auf Artikel mit dosageMg < bestellte dosageMg
 * 3. Sortiere absteigend nach dosageMg (größte zuerst = günstiger im Einkauf)
 * 4. Fülle die bestellte Menge (in mg) von oben nach unten auf
 * 5. Wenn exakt aufgefüllt → Substitution möglich
 *
 * @param shopProductId - z.B. "bpc-157"
 * @param orderedDosageMg - Bestellte Dosierung in mg (z.B. 20)
 * @param orderedQuantity - Bestellte Stückzahl (z.B. 1)
 * @param allArticles - Alle aktiven Artikel (aus DB, für Performance)
 */
export function resolveSubstitution(
  shopProductId: string,
  orderedDosageMg: number,
  orderedQuantity: number,
  allArticles: Array<{
    id: number;
    name: string;
    sku: string;
    stock: number | null;
    shopProductId: string | null;
    category: string | null;
  }>
): SubstitutionResult {
  // Gesamte benötigte mg
  const totalMgNeeded = orderedDosageMg * orderedQuantity;

  // Alle Artikel desselben Produkts mit kleinerer Dosierung
  const candidates = allArticles
    .filter(a =>
      a.shopProductId === shopProductId &&
      isSubstitutionEligible(a.category)
    )
    .map(a => ({
      ...a,
      // Konsolidierte Legacy-Lagerzeilen können die Dosierung nur in der SKU tragen.
      dosageMg: extractDosageMg(a.name) ?? extractDosageMg(a.sku) ?? 0,
      stock: a.stock ?? 0,
    }))
    .filter(a => a.dosageMg > 0 && a.dosageMg < orderedDosageMg && a.stock > 0)
    .sort((a, b) => b.dosageMg - a.dosageMg); // Größte zuerst

  if (!candidates.length) {
    return { possible: false, components: [], internalNote: "" };
  }

  // Exakte Kombination suchen. Der frühere Greedy-Ansatz konnte eine
  // vorhandene Lösung übersehen (z. B. 30 mg: 20 mg gewählt, 10 mg fehlt,
  // obwohl 2 × 15 mg verfügbar sind). Größere Varianten werden weiterhin
  // bevorzugt, aber nur wenn der verbleibende Bedarf exakt aufgeht.
  const memo = new Set<string>();
  const findExactPlan = (
    candidateIndex: number,
    remainingMg: number,
  ): Array<{ candidate: typeof candidates[number]; quantity: number }> | null => {
    if (Math.abs(remainingMg) < 1e-9) return [];
    if (candidateIndex >= candidates.length || remainingMg < 0) return null;

    const memoKey = `${candidateIndex}|${remainingMg.toFixed(6)}`;
    if (memo.has(memoKey)) return null;

    const candidate = candidates[candidateIndex];
    const maxQuantity = Math.min(
      candidate.stock,
      Math.floor((remainingMg + 1e-9) / candidate.dosageMg),
    );

    for (let quantity = maxQuantity; quantity >= 0; quantity--) {
      const nextRemaining = remainingMg - quantity * candidate.dosageMg;
      const rest = findExactPlan(candidateIndex + 1, nextRemaining);
      if (rest) {
        return quantity > 0 ? [{ candidate, quantity }, ...rest] : rest;
      }
    }

    memo.add(memoKey);
    return null;
  };

  const plan = findExactPlan(0, totalMgNeeded);
  if (!plan) {
    return { possible: false, components: [], internalNote: "" };
  }

  const components: SubstitutionComponent[] = plan.map(({ candidate, quantity }) => ({
    articleId: candidate.id,
    articleName: candidate.name,
    sku: candidate.sku,
    quantity,
    dosageMg: candidate.dosageMg,
  }));

  // Interne Notiz für WaWi
  const componentStr = components
    .map(c => `${c.quantity}× ${c.articleName} (${c.sku})`)
    .join(" + ");
  const internalNote = `[Smart Substitution] ${orderedQuantity}× ${orderedDosageMg}mg → ${componentStr}`;

  return { possible: true, components, internalNote };
}
