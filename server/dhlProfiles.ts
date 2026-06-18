/**
 * DHL Versandprofil-Definitionen
 *
 * Jedes Profil kapselt: Produktcode, Billing Number, Länderlogik,
 * Gewichtslimits, Customs-Pflicht und Aktivierungsstatus.
 *
 * Neue Profile aktivieren:
 *   1. Billing Number im DHL GKP prüfen (Format: EKP + Produktnr + Teilnahme)
 *   2. active: true setzen
 *   3. billingNumber eintragen (oder ENV-Variable ergänzen)
 *
 * NIEMALS direkt vom Frontend aufrufen – ausschließlich server-seitig.
 */

import { ENV } from "./env.js";

// ─── Typen ────────────────────────────────────────────────────────────────────

export type DhlProfileKey = "DHL_DE_STANDARD" | "DHL_DE_ECONOMY" | "DHL_EU" | "DHL_CH";

export interface DhlProfile {
  /** Anzeigename im UI */
  label:            string;
  /** DHL Produktcode für den API-Request */
  product:          string;
  /** 14-stellige Billing Number (EKP + Produktnr + Teilnahme) */
  billingNumber:    string | null;
  /** Ob dieses Profil aktuell aktiv/nutzbar ist */
  active:           boolean;
  /** Erlaubte Länder (ISO-3166-1 Alpha-2, normalisiert) */
  countries:        string[];
  /** Maximales Gewicht in Gramm */
  maxWeightG:       number;
  /** Ob Zollinformationen (customsDetails) Pflicht sind */
  customsRequired:  boolean;
  /** DHL Label-Format für Thermodrucker */
  labelFormat:      string;
  /** Grund warum Profil inaktiv ist (für UI-Anzeige) */
  inactiveReason?:  string;
}

// ─── EU-Länderliste (ISO-3166-1 Alpha-2) ─────────────────────────────────────

export const EU_COUNTRIES: string[] = [
  "AT", "BE", "BG", "CY", "CZ", "DK", "EE", "ES", "FI", "FR",
  "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL",
  "PL", "PT", "RO", "SE", "SI", "SK",
  // Nicht-EU aber DHL International üblich:
  "NO", "IS", "LI",
];

// ─── Profil-Definitionen ──────────────────────────────────────────────────────

export function getDhlProfiles(): Record<DhlProfileKey, DhlProfile> {
  return {
    DHL_DE_STANDARD: {
      label:           "DHL Paket DE Standard",
      product:         "V01PAK",
      billingNumber:   ENV.dhlBillingNumber ?? null,
      active:          true,
      countries:       ["DE"],
      maxWeightG:      31500,
      customsRequired: false,
      labelFormat:     "910-300-400",
    },

    DHL_DE_ECONOMY: {
      label:           "DHL Warenpost DE Economy",
      product:         "V62WP",
      billingNumber:   ENV.dhlBillingNumber ?? null, // Gleiche Abrechnungsnummer wie DHL Paket
      active:          !!(ENV.dhlBillingNumber),
      countries:       ["DE"],
      maxWeightG:      1000,
      customsRequired: false,
      labelFormat:     "910-300-400",
      inactiveReason:  ENV.dhlBillingNumber ? undefined : "DHL_BILLING_NUMBER nicht gesetzt",
    },

    DHL_EU: {
      label:           "DHL Paket EU",
      product:         "V53WPAK",
      billingNumber:   ENV.dhlBillingNumberEu || null,
      active:          !!(ENV.dhlBillingNumberEu),
      countries:       EU_COUNTRIES,
      maxWeightG:      31500,
      customsRequired: false,
      labelFormat:     "910-300-400",
      inactiveReason:  ENV.dhlBillingNumberEu ? undefined : "DHL_BILLING_NUMBER_EU nicht gesetzt",
    },

    DHL_CH: {
      label:           "DHL Paket Schweiz",
      product:         "V54EPAK",
      billingNumber:   null, // Noch nicht aktiviert – International-Vertrag nötig
      active:          false,
      countries:       ["CH"],
      maxWeightG:      31500,
      customsRequired: true,
      labelFormat:     "910-300-400",
      inactiveReason:  "DHL Paket Schweiz noch nicht aktiviert – Billing Number fehlt + Zollfelder nötig",
    },
  };
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

/**
 * Gibt das Profil für einen gegebenen Key zurück.
 * Wirft einen Fehler wenn das Profil nicht existiert oder inaktiv ist.
 */
export function getActiveProfile(key: DhlProfileKey): DhlProfile {
  const profiles = getDhlProfiles();
  const profile = profiles[key];
  if (!profile) {
    throw new Error(`Unbekanntes DHL-Profil: ${key}`);
  }
  if (!profile.active) {
    throw new Error(
      `DHL-Profil "${profile.label}" ist nicht aktiv. ${profile.inactiveReason ?? ""}`
    );
  }
  if (!profile.billingNumber) {
    throw new Error(
      `DHL-Profil "${profile.label}": Billing Number nicht konfiguriert.`
    );
  }
  return profile;
}

/**
 * Gibt das empfohlene Profil für ein Empfängerland zurück (ISO-3166-1 Alpha-2).
 * Gibt null zurück wenn kein aktives Profil passt.
 */
export function suggestProfile(countryCode: string): DhlProfileKey | null {
  const c = countryCode.toUpperCase();
  if (c === "DE") return "DHL_DE_STANDARD";
  if (c === "CH") return "DHL_CH";
  if (EU_COUNTRIES.includes(c)) return "DHL_EU";
  return null;
}

/**
 * Gibt alle Profile zurück die für ein Empfängerland verfügbar (aktiv) sind.
 */
export function getAvailableProfiles(countryCode: string): DhlProfileKey[] {
  const profiles = getDhlProfiles();
  const c = countryCode.toUpperCase();
  return (Object.keys(profiles) as DhlProfileKey[]).filter((key) => {
    const p = profiles[key];
    return p.active && p.countries.includes(c);
  });
}
