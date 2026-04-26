/**
 * 369 Research – Artikelkürzel / SKU System
 * Schema: Erster Buchstabe + Zweiter Buchstabe des Produktnamens + Milligrammzahl
 * Beispiel: BPC-157 5mg → BP5, Semaglutide 5mg → SE5
 * 
 * Bei Sonderfällen (Zahlen am Anfang, Bindestriche):
 * - "3G-TRIPLE G" → 3G + mg
 * - "5-Amino-1MQ" → 5A + mg
 * - "CJC-1295 + DAC" → CD + mg (CJC + DAC)
 * - "CJC-1295 no DAC" → CN + mg (CJC + no)
 * - "CJC-1295 + Ipamorelin Mix" → CI + mg
 * - "SS-31" → SS + mg
 * - "HGH Fragment 176-191" → HF + mg
 * - "IGF-1 LR3" → IL + mg
 * - Accessories: Forschungspen → FP, Starterset → ST, Bac Wasser → BW, etc.
 */

export interface ArticleCode {
  productId: string;
  name: string;
  code: string; // Base code without dosage (e.g. "BP")
  /** Generate full SKU for a given dosage */
  sku: (dosage: string) => string;
}

/**
 * Extract numeric part from dosage string
 * "10 mg" → "10", "5000 IU" → "5000", "10 ml" → "10", "10 mg (60 Caps)" → "10"
 */
function extractDosageNumber(dosage: string): string {
  const match = dosage.match(/^([\d.]+)/);
  return match ? match[1] : dosage.replace(/\s/g, "");
}

/**
 * Master mapping: productId → base code (2 letters/chars)
 * The full SKU = baseCode + dosageNumber
 */
const BASE_CODES: Record<string, string> = {
  // ─── Peptide (sichtbar) ──────────────────────────────
  "bpc-157": "BP",
  "tb-500": "TB",
  "melanotan-1": "M1",
  "melanotan-2": "M2",
  "pt-141": "PT",
  "ipamorelin": "IP",
  "cjc-1295-dac": "CD",
  "cjc-1295-no-dac": "CN",
  "tesamorelin": "TE",
  "thymosin-alpha-1": "TA",
  "epithalon": "EP",
  "selank": "SL",
  "semax": "SM",
  "dsip": "DS",
  "kpv": "KP",
  "kisspeptin-10": "KI",
  "mots-c": "MO",
  "ghk-cu": "GH",
  "nad-plus": "NA",
  "5-amino-1mq": "5A",
  "slu-pp-332": "SU",
  "glutathione": "GL",
  "3g-triple-g": "3G",
  "aod-9604": "AO",
  "adipotide": "AD",
  "cagrilinitide": "CA",
  "cjc-ipamorelin-kombi": "CI",
  "ghrp-2": "G2",
  "ghrp-6": "G6",
  "hcg": "HC",
  "hgh-fragment-176-191": "HF",
  "igf-1-lr3": "IL",
  "oxytocin": "OX",
  "tirzepatide": "TI",
  "hexarelin": "HE",
  "ss-31": "SS",

  // ─── Peptide (hidden) ────────────────────────────────
  "thymalin": "TM",
  "pinealon": "PI",
  "ahk-cu": "AH",
  "vitamin-b12": "VB",
  "hgh-somatropin": "HS",
  "humanin": "HU",
  "peg-mgf": "PM",
  "pe-22-28": "PE",
  "pnc-27": "PN",
  "snap-8": "SN",
  "ara-290": "AR",
  "b7-33": "B7",
  "ace-031": "AC",
  "aicar": "AI",
  "vip": "VI",

  // ─── Fertigpens ──────────────────────────────────────
  "pen-3g-reta": "PR",

  // ─── Bioregulatoren ──────────────────────────────────
  "bronchogen": "BR",
  "cardiogen": "CG",
  "livagen": "LI",
  "cortagen": "CO",
  "prostamax": "PX",
  "cartalax": "CX",
  "vesugen": "VE",
  "testagen": "TG",

  // ─── Fatburner / Fat-Dissolver ───────────────────────
  "lc216-l-carnitine": "LC",
  "lemon-bottle": "LB",
  "aqualyx": "AQ",

  // ─── Tabletten / Kapseln ─────────────────────────────
  "slu-pp-332-caps": "SC",
  "kpv-caps": "KC",

  // ─── 369 Beauty ──────────────────────────────────────
  "ghk-cu-daily-serum": "GD",
  "ghk-cu-needling-serum": "GN",

  // ─── Accessories / Zubehör ───────────────────────────
  "forschungspen": "FP",
  "starterset": "ST",
  "bac-wasser": "BW",
  "pen-kartusche": "PK",
  "insulinspritzen": "IS",
  "pen-nadeln": "ND",
};

/**
 * Get the base code (2 chars) for a product ID
 */
export function getBaseCode(productId: string): string {
  return BASE_CODES[productId] || productId.slice(0, 2).toUpperCase();
}

/**
 * Generate full SKU: BaseCode + DosageNumber
 * e.g. "bpc-157" + "10 mg" → "BP10"
 * e.g. "3g-triple-g" + "15 mg" → "3G15"
 */
export function generateSKU(productId: string, dosage: string): string {
  const base = getBaseCode(productId);
  const num = extractDosageNumber(dosage);
  return `${base}${num}`;
}

/**
 * Generate SKU from order item name + dosage
 * Tries to match by name to find the product ID first
 */
export function generateSKUFromName(itemName: string, dosage?: string | null): string {
  const normalizedName = itemName.toLowerCase().trim();
  
  // Try exact match on product ID
  if (BASE_CODES[normalizedName]) {
    const base = BASE_CODES[normalizedName];
    return dosage ? `${base}${extractDosageNumber(dosage)}` : base;
  }
  
  // Try matching by known product names
  const NAME_TO_ID: Record<string, string> = {
    "bpc-157": "bpc-157",
    "bpc 157": "bpc-157",
    "tb-500": "tb-500",
    "tb 500": "tb-500",
    "melanotan 1": "melanotan-1",
    "melanotan 2": "melanotan-2",
    "pt-141": "pt-141",
    "pt 141": "pt-141",
    "ipamorelin": "ipamorelin",
    "cjc-1295 + dac": "cjc-1295-dac",
    "cjc-1295 dac": "cjc-1295-dac",
    "cjc-1295 no dac": "cjc-1295-no-dac",
    "tesamorelin": "tesamorelin",
    "thymosin alpha-1": "thymosin-alpha-1",
    "thymosin alpha 1": "thymosin-alpha-1",
    "epithalon": "epithalon",
    "selank": "selank",
    "semax": "semax",
    "dsip": "dsip",
    "kpv": "kpv",
    "kisspeptin-10": "kisspeptin-10",
    "kisspeptin 10": "kisspeptin-10",
    "mots-c": "mots-c",
    "mots c": "mots-c",
    "ghk-cu": "ghk-cu",
    "ghk cu": "ghk-cu",
    "nad+": "nad-plus",
    "nad plus": "nad-plus",
    "5-amino-1mq": "5-amino-1mq",
    "5 amino 1mq": "5-amino-1mq",
    "slu-pp-332": "slu-pp-332",
    "glutathione": "glutathione",
    "3g-triple g (retatrutide)": "3g-triple-g",
    "3g-triple g": "3g-triple-g",
    "3g triple g": "3g-triple-g",
    "retatrutide": "3g-triple-g",
    "aod-9604": "aod-9604",
    "aod 9604": "aod-9604",
    "adipotide (fttp)": "adipotide",
    "adipotide": "adipotide",
    "cagrilinitide": "cagrilinitide",
    "cjc-1295 + ipamorelin mix": "cjc-ipamorelin-kombi",
    "cjc ipamorelin mix": "cjc-ipamorelin-kombi",
    "ghrp-2": "ghrp-2",
    "ghrp 2": "ghrp-2",
    "ghrp-6": "ghrp-6",
    "ghrp 6": "ghrp-6",
    "hcg": "hcg",
    "hgh fragment 176-191": "hgh-fragment-176-191",
    "hgh fragment": "hgh-fragment-176-191",
    "igf-1 lr3": "igf-1-lr3",
    "igf 1 lr3": "igf-1-lr3",
    "oxytocin": "oxytocin",
    "tirzepatide": "tirzepatide",
    "hexarelin": "hexarelin",
    "ss-31 (elamipretide)": "ss-31",
    "ss-31": "ss-31",
    "ss 31": "ss-31",
    "elamipretide": "ss-31",
    // Accessories
    "forschungspen": "forschungspen",
    "starterset – mischset": "starterset",
    "starterset": "starterset",
    "bac wasser 10ml": "bac-wasser",
    "bac wasser": "bac-wasser",
    "5x pen kartusche 3ml": "pen-kartusche",
    "pen kartusche": "pen-kartusche",
    "10er set b&d microfine insulinspritzen": "insulinspritzen",
    "insulinspritzen": "insulinspritzen",
    "10er set pen nadeln": "pen-nadeln",
    "pen nadeln": "pen-nadeln",
    // Hidden products
    "thymalin": "thymalin",
    "pinealon": "pinealon",
    "ahk-cu": "ahk-cu",
    "vitamin b12": "vitamin-b12",
    "hgh (somatropin)": "hgh-somatropin",
    "hgh somatropin": "hgh-somatropin",
    "humanin": "humanin",
    "peg-mgf": "peg-mgf",
    "pe-22-28": "pe-22-28",
    "pnc-27": "pnc-27",
    "snap-8": "snap-8",
    "ara 290": "ara-290",
    "b7-33": "b7-33",
    "ace-031": "ace-031",
    "aicar": "aicar",
    "vip (vasoactive intestinal peptide)": "vip",
    "vip": "vip",
    // Pens
    "pen 3g triple g (reta) – fertigpen": "pen-3g-reta",
    "pen 3g triple g": "pen-3g-reta",
    // Bioregulatoren
    "bronchogen": "bronchogen",
    "cardiogen": "cardiogen",
    "livagen": "livagen",
    "cortagen": "cortagen",
    "prostamax": "prostamax",
    "cartalax": "cartalax",
    "vesugen": "vesugen",
    "testagen": "testagen",
    // Fatburner
    "lc216 l-carnitine": "lc216-l-carnitine",
    "lemon bottle": "lemon-bottle",
    "aqualyx": "aqualyx",
    // Kapseln
    "slu-pp-332 kapseln": "slu-pp-332-caps",
    "kpv kapseln": "kpv-caps",
    // Beauty
    "ghk-cu daily serum 1%": "ghk-cu-daily-serum",
    "ghk-cu derma/needling-serum 1,5%": "ghk-cu-needling-serum",
  };

  // Find matching product ID
  for (const [key, productId] of Object.entries(NAME_TO_ID)) {
    if (normalizedName === key || normalizedName.includes(key)) {
      const base = BASE_CODES[productId] || productId.slice(0, 2).toUpperCase();
      return dosage ? `${base}${extractDosageNumber(dosage)}` : base;
    }
  }

  // Fallback: first 2 chars of name + dosage number
  const fallbackBase = itemName.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase();
  return dosage ? `${fallbackBase}${extractDosageNumber(dosage)}` : fallbackBase;
}

/**
 * Get all base codes for display/reference
 */
export function getAllBaseCodes(): Record<string, string> {
  return { ...BASE_CODES };
}
