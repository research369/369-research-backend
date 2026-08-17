import { createHash } from "node:crypto";
import { getDb, getPool } from "./db.js";
import { shopSettings } from "../drizzle/schema.js";

export type AddressValidationInput = {
  street: string;
  houseNumber: string;
  zip: string;
  city: string;
  country: string;
  deliveryType?: "home" | "packstation";
};

export type AddressValidationResult = {
  applicable: boolean;
  status: "valid" | "warning" | "unavailable" | "not_applicable";
  warnings: Array<{ code: string; field?: "street" | "houseNumber" | "zip" | "city"; message: string }>;
  provider: string | null;
  checkedAt: string;
  details: Record<string, unknown>;
};

type AddressValidationConfig = {
  enabled: boolean;
  countryCodes: string[];
  providerKey: string;
  providerBaseUrl: string;
  timeoutMs: number;
  houseNumberPattern: RegExp;
};

const normalize = (value: string) => value.trim().toLocaleLowerCase("de-DE").replace(/\s+/g, " ");
const escapeXml = (value: string) => value.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#039;" })[char] || char);

async function getConfig(): Promise<AddressValidationConfig> {
  const db = await getDb();
  const rows = db ? await db.select().from(shopSettings) : [];
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const pattern = values.address_validation_house_number_pattern || "^[0-9]{1,5}[a-zA-Z]?(?:\\s*[-/]\\s*[0-9]{1,5}[a-zA-Z]?)?$";
  return {
    enabled: values.address_validation_enabled !== "false",
    countryCodes: (values.address_validation_country_codes || "DE").split(",").map((entry) => entry.trim().toUpperCase()).filter(Boolean),
    providerKey: values.address_validation_provider_key || "openplz",
    providerBaseUrl: values.address_validation_provider_base_url || "https://openplzapi.org/de",
    timeoutMs: Math.min(10_000, Math.max(1_000, Number(values.address_validation_timeout_ms || 3500))),
    houseNumberPattern: new RegExp(pattern),
  };
}

function isGermanCountry(country: string, config: AddressValidationConfig): boolean {
  const normalized = normalize(country);
  return config.countryCodes.includes("DE") && ["de", "deutschland", "germany", "bundesrepublik deutschland"].includes(normalized);
}

async function providerGet(url: string, timeoutMs: number): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "369Research-AddressValidation/1.0" }, signal: controller.signal });
    if (!response.ok) throw new Error(`Adressquelle antwortet mit HTTP ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates PLZ/Ort/Straße using OpenPLZ. House numbers are deliberately checked for
 * German format only because the selected open street directory has no full house-number register.
 */
export async function validateGermanAddress(input: AddressValidationInput): Promise<AddressValidationResult> {
  const config = await getConfig();
  const checkedAt = new Date().toISOString();
  if (!config.enabled || !isGermanCountry(input.country, config) || input.deliveryType === "packstation") {
    return { applicable: false, status: "not_applicable", warnings: [], provider: null, checkedAt, details: { reason: input.deliveryType === "packstation" ? "packstation" : "country_not_configured" } };
  }

  const warnings: AddressValidationResult["warnings"] = [];
  const zip = input.zip.trim();
  const city = input.city.trim();
  const street = input.street.trim();
  const houseNumber = input.houseNumber.trim();

  if (!/^\d{5}$/.test(zip)) warnings.push({ code: "zip_format", field: "zip", message: "Die deutsche PLZ muss aus genau fünf Ziffern bestehen." });
  if (city.length < 2) warnings.push({ code: "city_missing", field: "city", message: "Bitte gib einen vollständigen Ort an." });
  if (street.length < 2) warnings.push({ code: "street_missing", field: "street", message: "Bitte gib eine vollständige Straße an." });
  if (!config.houseNumberPattern.test(houseNumber)) {
    warnings.push({ code: "house_number_format", field: "houseNumber", message: "Die Hausnummer ist nicht im erwarteten deutschen Format (z. B. 12, 12a oder 12-14)." });
  }

  if (warnings.length > 0) {
    return { applicable: true, status: "warning", warnings, provider: config.providerKey, checkedAt, details: { source: "local_format", providerConfigured: config.providerKey } };
  }

  try {
    const localityUrl = new URL(`${config.providerBaseUrl.replace(/\/$/, "")}/Localities`);
    localityUrl.searchParams.set("postalCode", zip);
    localityUrl.searchParams.set("name", city);
    localityUrl.searchParams.set("pageSize", "50");
    const localityRows = await providerGet(localityUrl.toString(), config.timeoutMs) as Array<Record<string, unknown>>;
    const localityMatches = localityRows.filter((row) => normalize(String(row.postalCode || row.postalcode || "")) === normalize(zip) && normalize(String(row.name || "")) === normalize(city));
    if (localityMatches.length === 0) {
      warnings.push({ code: "zip_city_mismatch", field: "city", message: `Die Kombination aus PLZ ${zip} und Ort „${city}“ wurde nicht gefunden.` });
    }

    const streetUrl = new URL(`${config.providerBaseUrl.replace(/\/$/, "")}/Streets`);
    streetUrl.searchParams.set("name", street);
    streetUrl.searchParams.set("postalCode", zip);
    streetUrl.searchParams.set("locality", city);
    streetUrl.searchParams.set("pageSize", "50");
    const streetRows = await providerGet(streetUrl.toString(), config.timeoutMs) as Array<Record<string, unknown>>;
    const streetMatches = streetRows.filter((row) => normalize(String(row.name || "")) === normalize(street)
      && normalize(String(row.postalCode || row.postalcode || "")) === normalize(zip)
      && normalize(String(row.locality || "")) === normalize(city));
    // Der öffentliche Straßenendpunkt ist je nach Gebiet nicht vollständig verfügbar.
    // Daher darf ein leerer Treffer niemals als falsche Kundenadresse dargestellt werden.
    // Erst ein explizit konfigurierter Präzisionsprovider darf daraus eine rote Warnung machen.
    const streetDirectoryAvailable = streetRows.length > 0;
    const streetContextMatch = streetMatches.length > 0;

    return {
      applicable: true,
      status: warnings.length > 0 ? "warning" : "valid",
      warnings,
      provider: config.providerKey,
      checkedAt,
      details: {
        localityMatches: localityMatches.length,
        streetMatches: streetMatches.length,
        streetDirectoryAvailable,
        streetContextMatch,
        houseNumberValidation: "format_only",
        providerBaseUrl: config.providerBaseUrl,
      },
    };
  } catch (error) {
    return {
      applicable: true,
      status: "unavailable",
      warnings: [{ code: "provider_unavailable", message: "Die Adressquelle ist gerade nicht erreichbar. Bitte prüfe die Adresse sorgfältig oder bestätige sie bewusst." }],
      provider: config.providerKey,
      checkedAt,
      details: { error: error instanceof Error ? error.message : "unknown_provider_error" },
    };
  }
}

function evidenceSvg(input: AddressValidationInput, result: AddressValidationResult, confirmedBy: string, confirmedAt: Date): string {
  const warningLines = result.warnings.length > 0 ? result.warnings.map((warning) => warning.message) : ["Adressprüfung wurde bewusst bestätigt."];
  const textLines = [
    "369 Research · Adressnachweis",
    "",
    `Eingegebene Lieferadresse:`,
    `${input.street} ${input.houseNumber}`,
    `${input.zip} ${input.city}`,
    `${input.country}`,
    "",
    "Prüfhinweis:",
    ...warningLines,
    "",
    `Bewusst bestätigt von: ${confirmedBy}`,
    `Bestätigt am: ${confirmedAt.toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}`,
    `Datenquelle: ${result.provider || "keine externe Quelle"}`,
  ];
  const rows = textLines.map((line, index) => `<text x="56" y="${92 + index * 30}" font-family="Arial, Helvetica, sans-serif" font-size="${index === 0 ? 26 : 17}" font-weight="${index === 0 || line.endsWith(":") ? 700 : 400}" fill="${index === 0 ? "#0f2d52" : "#172033"}">${escapeXml(line)}</text>`).join("\n");
  const height = Math.max(560, 128 + textLines.length * 30);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="${height}" viewBox="0 0 1100 ${height}"><rect width="1100" height="${height}" fill="#f8fafc"/><rect x="32" y="28" width="1036" height="${height - 56}" rx="18" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/><rect x="32" y="28" width="1036" height="14" rx="7" fill="#dc2626"/>${rows}<text x="56" y="${height - 48}" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="#64748b">Unveränderbarer Adressnachweis · Speicherung in Kunden- und Bestellakte</text></svg>`;
}

export async function persistAddressValidation(params: {
  input: AddressValidationInput;
  result: AddressValidationResult;
  context: "checkout" | "customer_create" | "customer_update" | "manual_order";
  customerId?: number | null;
  orderId?: string | null;
  overrideConfirmed?: boolean;
  confirmedBy?: string;
}): Promise<number | null> {
  if (!params.result.applicable) return null;
  const pool = await getPool();
  if (!pool) throw new Error("Datenbankverbindung für Adressnachweis nicht verfügbar");
  const confirmedAt = params.overrideConfirmed ? new Date() : null;
  const evidence = params.overrideConfirmed ? evidenceSvg(params.input, params.result, params.confirmedBy || "Kunde", confirmedAt!) : null;
  const evidenceSha = evidence ? createHash("sha256").update(evidence).digest("hex") : null;
  const inserted = await pool.query(
    `INSERT INTO address_validation_records (customer_id, order_id, context, country_code, submitted_address_json, provider_key, provider_checked_at, validation_status, warnings_json, details_json, override_confirmed, override_confirmed_at, override_confirmed_by, evidence_svg, evidence_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [
      params.customerId || null,
      params.orderId || null,
      params.context,
      "DE",
      JSON.stringify(params.input),
      params.result.provider,
      params.result.checkedAt,
      params.result.status,
      JSON.stringify(params.result.warnings),
      JSON.stringify(params.result.details),
      params.overrideConfirmed ? 1 : 0,
      confirmedAt,
      params.confirmedBy || null,
      evidence,
      evidenceSha,
    ],
  );
  return Number(inserted.rows[0]?.id || 0) || null;
}
