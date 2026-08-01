/**
 * DHL Parcel DE Shipping Service
 *
 * Implementiert die DHL Parcel DE Shipping REST API v2.
 * Phase 1: DE national, V01PAK, Sandbox-Modus.
 *
 * Authentifizierung (zwei Ebenen):
 *   1. dhl-api-key Header  (Consumer Key aus DHL Developer Portal)
 *   2. HTTP Basic Auth     (Geschäftskundenportal Username + Password)
 *
 * OAuth2-Vorbereitung:
 *   Die Struktur ist so gehalten, dass ein zukünftiger OAuth2-Token-Flow
 *   (DHL Authentication API: POST /parcel/de/auth/ropc/token) ohne
 *   Refactoring eingebaut werden kann. Dafür ist buildAuthHeaders()
 *   als eigene Funktion isoliert.
 *
 * Modularität:
 *   Kein EU/Auslands-Code. Erweiterung erfolgt durch neue Produkt-Funktionen
 *   (z.B. createShipmentEU) ohne bestehende Funktionen zu ändern.
 *
 * NIEMALS direkt vom Frontend aufrufen – ausschließlich server-seitig.
 */

import { ENV } from "./env.js";

// ─── Konstanten ───────────────────────────────────────────────────────────────

const DHL_API_BASE_SANDBOX = "https://api-sandbox.dhl.com/parcel/de/shipping/v2";
const DHL_API_BASE_PROD    = "https://api-eu.dhl.com/parcel/de/shipping/v2";

/** Standard-Absender gemäß Konfiguration */
  const DEFAULT_SHIPPER = {
  name1:          "Core Versand und Logistik",
  addressStreet:  "Klingenhagen",
  addressHouse:   "31",
  postalCode:     "48336",
  city:           "Sassenberg",
  country:        "DEU",
} as const;

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface DhlConsignee {
  name1:         string;
  name2?:        string;  // Zusatzzeile (z.B. Vorname Nachname wenn name1 = Firma)
  name3?:        string;  // Weitere Zusatzzeile
  addressStreet: string;
  addressHouse:  string;
  postalCode:    string;
  city:          string;
  country:       string;  // ISO-3166-1 alpha-3, z.B. "DEU"
  email?:        string;
  phone?:        string;
}

export interface DhlShipmentInput {
  /** Interne Bestellnummer (wird als refNo mitgegeben, min. 8 Zeichen) */
  orderId:      string;
  consignee:    DhlConsignee;
  /** Gewicht in Gramm (Default: 500g) */
  weightGrams?: number;
  /** DHL Produktcode – überschreibt ENV-Default (V01PAK). Aus dhlProfiles.ts. */
  productCode?:   string;
  /** 14-stellige Billing Number – überschreibt ENV.dhlBillingNumber. Aus dhlProfiles.ts. */
  billingNumber?: string;
}

export interface DhlShipmentResult {
  success:        boolean;
  trackingNumber?: string;
  labelUrl?:       string;
  /** Base64-kodiertes PDF-Label (falls URL nicht verfügbar) */
  labelBase64?:    string;
  error?:          string;
  /** HTTP-Statuscode der DHL-Antwort */
  statusCode?:     number;
}

// ─── Auth-Hilfsfunktionen ─────────────────────────────────────────────────────

/**
 * Baut die Auth-Header für DHL API-Calls.
 *
 * Aktuell: API-Key + Basic Auth.
 * Zukunft: Wenn DHL OAuth2-Token-Flow aktiviert wird, wird hier
 *          ein Bearer-Token eingesetzt ohne weitere Änderungen.
 */
function buildAuthHeaders(): Record<string, string> {
  const apiKey   = ENV.dhlApiKey;
  const username = ENV.dhlBusinessUsername;
  const password = ENV.dhlBusinessPassword;

  if (!apiKey || !username || !password) {
    throw new Error(
      "DHL-Konfiguration unvollständig: DHL_API_KEY, DHL_BUSINESS_USERNAME " +
      "und DHL_BUSINESS_PASSWORD müssen gesetzt sein."
    );
  }

  const basicToken = Buffer.from(`${username}:${password}`).toString("base64");

  return {
    "dhl-api-key":  apiKey,
    "Authorization": `Basic ${basicToken}`,
    "Content-Type": "application/json",
  };
}

/** Gibt den korrekten API-Basis-URL zurück (Sandbox vs. Production) */
function getApiBase(): string {
  return ENV.dhlSandbox ? DHL_API_BASE_SANDBOX : DHL_API_BASE_PROD;
}

// ─── Validierung ──────────────────────────────────────────────────────────────

/**
 * Validiert die Empfängeradresse vor dem DHL-Call.
 * Gibt null zurück wenn alles ok, sonst eine Fehlermeldung.
 */
export function validateConsignee(c: DhlConsignee): string | null {
  if (!c.name1?.trim())         return "Empfänger: Name fehlt";
  if (!c.addressStreet?.trim()) return "Empfänger: Straße fehlt";
  if (!c.addressHouse?.trim())  return "Empfänger: Hausnummer fehlt";
  if (!c.postalCode?.trim())    return "Empfänger: PLZ fehlt";
  if (!c.city?.trim())          return "Empfänger: Stadt fehlt";
  if (!c.country?.trim())       return "Empfänger: Land fehlt";

  return null;
}

/**
 * Normalisiert einen Ländernamen/-code auf ISO-3166-1 Alpha-3 (für DHL API).
 * Unterstützt Alpha-2, Alpha-3 und deutsche Freitexte.
 */
export function normalizeCountryToAlpha3(raw: string): string {
  if (!raw) return "";
  const s = raw.trim().toUpperCase();

  const alpha2Map: Record<string, string> = {
    DE: "DEU", AT: "AUT", CH: "CHE", FR: "FRA", NL: "NLD",
    BE: "BEL", LU: "LUX", PL: "POL", CZ: "CZE", SK: "SVK",
    HU: "HUN", RO: "ROU", BG: "BGR", HR: "HRV", SI: "SVN",
    IT: "ITA", ES: "ESP", PT: "PRT", GR: "GRC", CY: "CYP",
    MT: "MLT", IE: "IRL", FI: "FIN", SE: "SWE", DK: "DNK",
    EE: "EST", LV: "LVA", LT: "LTU", NO: "NOR", IS: "ISL", LI: "LIE",
  };

  const textMap: Record<string, string> = {
    DEUTSCHLAND: "DEU", GERMANY: "DEU",
    AUSTRIA: "AUT", OESTERREICH: "AUT",
    // Mit Umlaut (direkt aus DB-Werten)
    "\u00d6STERREICH": "AUT",  // Österreich
    SCHWEIZ: "CHE", SWITZERLAND: "CHE",
    FRANKREICH: "FRA", FRANCE: "FRA",
    NIEDERLANDE: "NLD", NETHERLANDS: "NLD",
    BELGIEN: "BEL", BELGIUM: "BEL",
    LUXEMBURG: "LUX", LUXEMBOURG: "LUX",
    POLEN: "POL", POLAND: "POL",
    TSCHECHIEN: "CZE",
    ITALIEN: "ITA", ITALY: "ITA",
    SPANIEN: "ESP", SPAIN: "ESP",
    PORTUGAL: "PRT",
    GRIECHENLAND: "GRC", GREECE: "GRC",
    SCHWEDEN: "SWE", SWEDEN: "SWE",
    NORWEGEN: "NOR", NORWAY: "NOR",
    FINNLAND: "FIN", FINLAND: "FIN",
    IRLAND: "IRL", IRELAND: "IRL",
    UNGARN: "HUN", HUNGARY: "HUN",
    KROATIEN: "HRV", CROATIA: "HRV",
    SLOWENIEN: "SVN", SLOVENIA: "SVN",
    SLOWAKEI: "SVK", SLOVAKIA: "SVK",
    ESTLAND: "EST", ESTONIA: "EST",
    LETTLAND: "LVA", LATVIA: "LVA",
    LITAUEN: "LTU", LITHUANIA: "LTU",
    ZYPERN: "CYP", CYPRUS: "CYP",
    MALTA: "MLT",
    RUM\u00c4NIEN: "ROU", ROMANIA: "ROU",
    BULGARIEN: "BGR", BULGARIA: "BGR",
    D\u00c4NEMARK: "DNK", DENMARK: "DNK",
    ISLAND: "ISL", ICELAND: "ISL",
    LIECHTENSTEIN: "LIE",
    // Weitere Varianten
    CZECH_REPUBLIC: "CZE", "CZECH REPUBLIC": "CZE",
    // Nicht-EU Länder und Balkan
    ALBANIEN: "ALB", ALBANIA: "ALB",
    ANDORRA: "AND",
    "BOSNIEN-HERZEGOWINA": "BIH", BOSNIEN: "BIH", BOSNIA: "BIH",
    GEORGIEN: "GEO", GEORGIA: "GEO",
    KOSOVO: "XKX",
    MOLDAU: "MDA", MOLDOVA: "MDA",
    MONACO: "MCO",
    MONTENEGRO: "MNE",
    NORDMAZEDONIEN: "MKD", MAZEDONIEN: "MKD", MACEDONIA: "MKD",
    "SAN MARINO": "SMR",
    SERBIEN: "SRB", SERBIA: "SRB",
    T\u00dcRKEI: "TUR", TURKEY: "TUR", T\u00dcRKIYE: "TUR",
    UKRAINE: "UKR",
    "VEREINIGTES K\u00d6NIGREICH": "GBR", "UNITED KINGDOM": "GBR", GROSSBRITANNIEN: "GBR",
    WEI\u00dfRUSSLAND: "BLR", BELARUS: "BLR",
  };

  if (/^[A-Z]{3}$/.test(s)) return s;
  if (alpha2Map[s]) return alpha2Map[s];
  if (textMap[s]) return textMap[s];
  return raw.trim();
}

// ─── Haupt-Funktion ───────────────────────────────────────────────────────────

/**
 * Erstellt ein DHL-Label für eine DE-nationale Sendung (V01PAK).
 *
 * Phase 1 Scope:
 *   - Produkt: V01PAK (DHL Paket)
 *   - Nur Deutschland (DEU)
 *   - Sandbox-Modus wenn ENV.dhlSandbox = true
 *
 * Erweiterung für EU/International:
 *   Neue Funktion createDhlShipmentEU() mit V53WPAK hinzufügen.
 *   Diese Funktion bleibt unverändert.
 */
export async function createDhlShipmentDE(
  input: DhlShipmentInput
): Promise<DhlShipmentResult> {
  // 1. Validierung
  const validationError = validateConsignee(input.consignee);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // 2. Billing Number prüfen (Profil-Überschreibung hat Vorrang vor ENV)
  const billingNumber = input.billingNumber ?? ENV.dhlBillingNumber;
  if (!billingNumber || billingNumber.length < 14) {
    return {
      success: false,
      error: "DHL_BILLING_NUMBER nicht konfiguriert oder ungültig (14 Zeichen erwartet)",
    };
  }

  // 2b. Produktcode (Profil-Überschreibung hat Vorrang vor Hardcode)
  const productCode = input.productCode ?? "V01PAK";

  // 3. Auth-Header bauen (wirft Error wenn Credentials fehlen)
  let headers: Record<string, string>;
  try {
    headers = buildAuthHeaders();
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // 4. Request-Body zusammenstellen
  const refNo = input.orderId.length >= 8
    ? input.orderId
    : input.orderId.padEnd(8, "0");

  const body = {
    profile: "STANDARD_GRUPPENPROFIL",
    // 100x150mm Thermal Label (Zebra/Munbyn) – kein A4
    // 910-300-400 = 103x150mm Thermal (Falteetiketten) – korrektes Format für Thermodrucker
    printSettings: {
      printerDpi:   300,
      encodingType: "PDF",
      labelFormat:  "910-300-400",
    },
    shipments: [
      {
        product:       productCode,
        billingNumber: billingNumber,
        refNo:         refNo,
        shipper: {
          name1:         DEFAULT_SHIPPER.name1,
          addressStreet: DEFAULT_SHIPPER.addressStreet,
          addressHouse:  DEFAULT_SHIPPER.addressHouse,
          postalCode:    DEFAULT_SHIPPER.postalCode,
          city:          DEFAULT_SHIPPER.city,
          country:       DEFAULT_SHIPPER.country,
        },
        consignee: {
          name1:         input.consignee.name1.slice(0, 50),
          ...(input.consignee.name2 ? { name2: input.consignee.name2.slice(0, 50) } : {}),
          ...(input.consignee.name3 ? { name3: input.consignee.name3.slice(0, 50) } : {}),
          addressStreet: input.consignee.addressStreet,
          addressHouse:  input.consignee.addressHouse,
          postalCode:    input.consignee.postalCode,
          city:          input.consignee.city,
          country:       "DEU",
          ...(input.consignee.email ? { email: input.consignee.email } : {}),
          ...(input.consignee.phone ? { phone: input.consignee.phone } : {}),
        },
        details: {
          weight: {
            uom:   "g",
            value: input.weightGrams ?? 1000,
          },
        },
      },
    ],
  };

  // 5. DHL API-Call
  const apiUrl = `${getApiBase()}/orders?validate=false&printOnlyIfCodable=false&docFormat=PDF&labelResponseType=INCLUDE`;

  let rawResponse: Response;
  let responseText: string;

  try {
    rawResponse = await fetch(apiUrl, {
      method:  "POST",
      headers,
      body:    JSON.stringify(body),
    });
    responseText = await rawResponse.text();
  } catch (err: any) {
    return {
      success:    false,
      error:      `DHL API nicht erreichbar: ${err.message}`,
      statusCode: 0,
    };
  }

  // 6. Antwort parsen
  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch {
    return {
      success:    false,
      error:      `DHL API: Ungültige JSON-Antwort (HTTP ${rawResponse.status})`,
      statusCode: rawResponse.status,
    };
  }

  // 7. Fehlerbehandlung
  if (!rawResponse.ok) {
    const detail =
      data?.detail ||
      data?.title ||
      data?.items?.[0]?.validationMessages?.[0]?.validationMessage ||
      JSON.stringify(data).slice(0, 300);
    console.error(`[dhlService] DHL API Fehler HTTP ${rawResponse.status}:`, detail);
    return {
      success:    false,
      error:      `DHL Fehler (${rawResponse.status}): ${detail}`,
      statusCode: rawResponse.status,
    };
  }

  // 8. Erfolg: Trackingnummer und Label-URL extrahieren
  const shipment = data?.items?.[0];
  if (!shipment) {
    return {
      success:    false,
      error:      "DHL API: Keine Sendungsdaten in der Antwort",
      statusCode: rawResponse.status,
    };
  }

  // DHL Response-Felder: shipmentNo (primär), Fallbacks für andere Konto-Typen
  const trackingNumber =
    (shipment.shipmentNo as string | undefined) ??
    (shipment.trackingId as string | undefined) ??
    (shipment.shipmentTrackingNumber as string | undefined);

  // Label: entweder als URL oder als Base64-PDF (b64 oder content)
  const labelUrl    = shipment.label?.url as string | undefined;
  const labelBase64 =
    (shipment.label?.b64 as string | undefined) ??
    (shipment.label?.content as string | undefined);

  if (!trackingNumber) {
    return {
      success:    false,
      error:      "DHL API: Keine Trackingnummer in der Antwort",
      statusCode: rawResponse.status,
    };
  }

  console.log(`[dhlService] Label erstellt: ${trackingNumber} (Sandbox: ${ENV.dhlSandbox})`);

  return {
    success:       true,
    trackingNumber,
    labelUrl:      labelUrl ?? undefined,
    labelBase64:   labelBase64 ?? undefined,
    statusCode:    rawResponse.status,
  };
}

// ─── EU-Funktion (Phase 2) ────────────────────────────────────────────────────

/**
 * Erstellt ein DHL-Label für EU-internationale Sendungen (V53WPAK).
 *
 * Phase 2 Scope:
 *   - Produkt: V53WPAK (DHL Paket International)
 *   - Alle EU-Länder + NO, IS, LI
 *   - Billing Number: DHL_BILLING_NUMBER_EU (63979135285301)
 *   - Kein Zoll (customsDetails nicht erforderlich)
 *   - Sandbox-Modus wenn ENV.dhlSandbox = true
 *
 * DHL_DE_STANDARD (createDhlShipmentDE) bleibt vollständig unverändert.
 */
export async function createDhlShipmentEU(
  input: DhlShipmentInput
): Promise<DhlShipmentResult> {
  // 1. Billing Number prüfen
  const billingNumber = input.billingNumber ?? ENV.dhlBillingNumberEu;
  if (!billingNumber || billingNumber.length < 14) {
    return {
      success: false,
      error: "DHL_BILLING_NUMBER_EU nicht konfiguriert oder ungültig (14 Zeichen erwartet)",
    };
  }

  // 2. Produktcode
  const productCode = input.productCode ?? "V53WPAK";

  // 3. Ländernormalisierung (Freitext → Alpha-3)
  const countryAlpha3 = normalizeCountryToAlpha3(input.consignee.country);
  if (!countryAlpha3) {
    return { success: false, error: "Empfänger: Land fehlt oder nicht erkannt" };
  }

  // 4. Basis-Validierung (ohne DE-Einschränkung)
  const c = input.consignee;
  if (!c.name1?.trim())         return { success: false, error: "Empfänger: Name fehlt" };
  if (!c.addressStreet?.trim()) return { success: false, error: "Empfänger: Straße fehlt" };
  if (!c.addressHouse?.trim())  return { success: false, error: "Empfänger: Hausnummer fehlt" };
  if (!c.postalCode?.trim())    return { success: false, error: "Empfänger: PLZ fehlt" };
  if (!c.city?.trim())          return { success: false, error: "Empfänger: Stadt fehlt" };

  // 5. Auth-Header
  let headers: Record<string, string>;
  try {
    headers = buildAuthHeaders();
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // 6. Request-Body
  const refNo = input.orderId.length >= 8
    ? input.orderId
    : input.orderId.padEnd(8, "0");

  const body = {
    profile: "STANDARD_GRUPPENPROFIL",
    printSettings: {
      printerDpi:   300,
      encodingType: "PDF",
      labelFormat:  "910-300-400",
    },
    shipments: [
      {
        product:       productCode,
        billingNumber: billingNumber,
        refNo:         refNo,
        shipper: {
          name1:         DEFAULT_SHIPPER.name1,
          addressStreet: DEFAULT_SHIPPER.addressStreet,
          addressHouse:  DEFAULT_SHIPPER.addressHouse,
          postalCode:    DEFAULT_SHIPPER.postalCode,
          city:          DEFAULT_SHIPPER.city,
          country:       DEFAULT_SHIPPER.country,
        },
        consignee: {
          name1:         c.name1.slice(0, 50),
          ...(c.name2 ? { name2: c.name2.slice(0, 50) } : {}),
          ...(c.name3 ? { name3: c.name3.slice(0, 50) } : {}),
          addressStreet: c.addressStreet,
          addressHouse:  c.addressHouse,
          postalCode:    c.postalCode,
          city:          c.city,
          country:       countryAlpha3,
          ...(c.email ? { email: c.email } : {}),
          ...(c.phone ? { phone: c.phone } : {}),
        },
        details: {
          weight: {
            uom:   "g",
            value: input.weightGrams ?? 1000,
          },
        },
      },
    ],
  };

  // 7. DHL API-Call
  const apiUrl = `${getApiBase()}/orders?validate=false&printOnlyIfCodable=false&docFormat=PDF&labelResponseType=INCLUDE`;

  let rawResponse: Response;
  let responseText: string;

  try {
    rawResponse = await fetch(apiUrl, {
      method:  "POST",
      headers,
      body:    JSON.stringify(body),
    });
    responseText = await rawResponse.text();
  } catch (err: any) {
    return {
      success:    false,
      error:      `DHL API nicht erreichbar: ${err.message}`,
      statusCode: 0,
    };
  }

  // 8. Antwort parsen
  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch {
    return {
      success:    false,
      error:      `DHL API: Ungültige JSON-Antwort (HTTP ${rawResponse.status})`,
      statusCode: rawResponse.status,
    };
  }

  // 9. Fehlerbehandlung
  if (!rawResponse.ok) {
    const detail =
      data?.detail ||
      data?.title ||
      data?.items?.[0]?.validationMessages?.[0]?.validationMessage ||
      JSON.stringify(data).slice(0, 300);
    console.error(`[dhlService/EU] DHL API Fehler HTTP ${rawResponse.status}:`, detail);
    return {
      success:    false,
      error:      `DHL Fehler EU (${rawResponse.status}): ${detail}`,
      statusCode: rawResponse.status,
    };
  }

  // 10. Erfolg
  const shipment = data?.items?.[0];
  if (!shipment) {
    return {
      success:    false,
      error:      "DHL API: Keine Sendungsdaten in der Antwort",
      statusCode: rawResponse.status,
    };
  }

  const trackingNumber =
    (shipment.shipmentNo as string | undefined) ??
    (shipment.trackingId as string | undefined) ??
    (shipment.shipmentTrackingNumber as string | undefined);

  const labelUrl    = shipment.label?.url as string | undefined;
  const labelBase64 =
    (shipment.label?.b64 as string | undefined) ??
    (shipment.label?.content as string | undefined);

  if (!trackingNumber) {
    return {
      success:    false,
      error:      "DHL API: Keine Trackingnummer in der Antwort",
      statusCode: rawResponse.status,
    };
  }

  console.log(`[dhlService/EU] Label erstellt: ${trackingNumber} (Sandbox: ${ENV.dhlSandbox})`);

  return {
    success:       true,
    trackingNumber,
    labelUrl:      labelUrl ?? undefined,
    labelBase64:   labelBase64 ?? undefined,
    statusCode:    rawResponse.status,
  };
}
