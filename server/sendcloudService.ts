/**
 * Sendcloud API Service
 * Handles label creation, tracking, and webhook processing
 * Zero-Risk-Mode: only writes to existing + additive optional fields
 */

import { createHmac } from "crypto";
import { ENV } from "./env.js";

const SENDCLOUD_API_URL = "https://panel.sendcloud.sc/api/v3";

interface SendcloudAddress {
  name: string;
  company_name?: string;
  address: string;
  house_number: string;
  city: string;
  postal_code: string;
  country: string; // ISO 2-letter
  email?: string;
  telephone?: string;
}

interface SendcloudParcelInput {
  name: string;
  company_name?: string;
  address: string;
  house_number: string;
  city: string;
  postal_code: string;
  country: string;
  email?: string;
  telephone?: string;
  shipment: {
    id: number; // Sendcloud shipping method ID
  };
  weight: string; // in kg, e.g. "2.000"
  order_number: string;
  request_label: boolean;
}

interface SendcloudParcelResponse {
  parcel: {
    id: number;
    tracking_number: string;
    tracking_url: string;
    label: {
      normal_printer: string[];
      label_printer: string;
    };
    status: {
      id: number;
      message: string;
    };
    shipment: {
      id: number;
      name: string;
    };
  };
}

interface SendcloudWebhookPayload {
  action: string;
  timestamp: number;
  parcel: {
    id: number;
    tracking_number: string;
    status: {
      id: number;
      message: string;
    };
    order_number: string;
  };
}

/**
 * Map Sendcloud status ID to our internal shipping status
 */
export function mapSendcloudStatus(statusId: number): string {
  // Sendcloud status IDs: https://support.sendcloud.com/hc/en-us/articles/360024967012
  if (statusId === 1000) return "delivered";
  if (statusId >= 800) return "shipped";
  if (statusId >= 500) return "label_created";
  if (statusId === 11 || statusId === 12) return "failed";
  return "processing";
}

/**
 * Create a Sendcloud parcel and get a shipping label
 */
export async function createSendcloudLabel(params: {
  orderId: string;
  firstName: string;
  lastName: string;
  company?: string;
  street: string;
  houseNumber: string;
  city: string;
  zip: string;
  country: string;
  email?: string;
  phone?: string;
  weightKg?: number;
}): Promise<{
  success: boolean;
  parcelId?: number;
  trackingNumber?: string;
  trackingUrl?: string;
  labelUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}> {
  const publicKey = ENV.sendcloudPublicKey;
  const secretKey = ENV.sendcloudSecretKey;

  if (!publicKey || !secretKey) {
    return {
      success: false,
      errorCode: "INTERNAL_ERROR",
      errorMessage: "Sendcloud API keys not configured",
    };
  }

  // Determine shipping method ID based on country
  // DHL Paket DE (2kg) = method ID varies by account, default to standard
  const shipmentId = getShipmentId(params.country);
  const weight = (params.weightKg || 2.0).toFixed(3);

  const parcelData: SendcloudParcelInput = {
    name: `${params.firstName} ${params.lastName}`.trim(),
    company_name: params.company || undefined,
    address: params.street,
    house_number: params.houseNumber,
    city: params.city,
    postal_code: params.zip,
    country: normalizeCountryCode(params.country),
    email: params.email || undefined,
    telephone: params.phone || undefined,
    shipment: { id: shipmentId },
    weight,
    order_number: params.orderId,
    request_label: true,
  };

  try {
    const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    const response = await fetch(`${SENDCLOUD_API_URL}/parcels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({ parcel: parcelData }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[Sendcloud] API error:", response.status, errorBody);

      // Classify error
      let errorCode = "SENDCLOUD_API_ERROR";
      if (response.status === 400) errorCode = "VALIDATION_ERROR";
      if (response.status === 409) errorCode = "DUPLICATE_LABEL";
      if (response.status >= 500) errorCode = "SENDCLOUD_API_ERROR";

      return {
        success: false,
        errorCode,
        errorMessage: `Sendcloud API error ${response.status}: ${errorBody.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as SendcloudParcelResponse;
    const parcel = data.parcel;

    return {
      success: true,
      parcelId: parcel.id,
      trackingNumber: parcel.tracking_number,
      trackingUrl: parcel.tracking_url,
      labelUrl: parcel.label?.normal_printer?.[0] || parcel.label?.label_printer || undefined,
    };
  } catch (err: any) {
    console.error("[Sendcloud] Network error:", err.message);
    return {
      success: false,
      errorCode: "NETWORK_ERROR",
      errorMessage: `Network error: ${err.message}`,
    };
  }
}

/**
 * Verify Sendcloud webhook signature
 */
export function verifySendcloudWebhook(
  payload: string,
  signature: string,
  secret: string
): boolean {
  try {
    const hmac = createHmac("sha256", secret);
    hmac.update(payload);
    const expected = hmac.digest("hex");
    return expected === signature;
  } catch {
    return false;
  }
}

/**
 * Parse and validate a Sendcloud webhook payload
 */
export function parseSendcloudWebhook(body: unknown): SendcloudWebhookPayload | null {
  try {
    const payload = body as SendcloudWebhookPayload;
    if (!payload.action || !payload.parcel?.id) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Get Sendcloud shipment method ID based on destination country
 * These IDs are account-specific — defaults to DHL Paket (DE)
 * Configure via SENDCLOUD_SHIPMENT_ID_DE / SENDCLOUD_SHIPMENT_ID_EU env vars
 */
function getShipmentId(country: string): number {
  const normalized = normalizeCountryCode(country);
  if (normalized === "DE") {
    return parseInt(ENV.sendcloudShipmentIdDe || "8", 10); // DHL Paket DE default
  }
  // EU / international
  return parseInt(ENV.sendcloudShipmentIdEu || "8", 10);
}

/**
 * Normalize country string to ISO 2-letter code
 */
function normalizeCountryCode(country: string): string {
  const map: Record<string, string> = {
    "Deutschland": "DE",
    "Germany": "DE",
    "DE": "DE",
    "Österreich": "AT",
    "Austria": "AT",
    "AT": "AT",
    "Schweiz": "CH",
    "Switzerland": "CH",
    "CH": "CH",
    "Niederlande": "NL",
    "Netherlands": "NL",
    "NL": "NL",
    "Frankreich": "FR",
    "France": "FR",
    "FR": "FR",
    "Belgien": "BE",
    "Belgium": "BE",
    "BE": "BE",
    "Luxemburg": "LU",
    "Luxembourg": "LU",
    "LU": "LU",
    "Polen": "PL",
    "Poland": "PL",
    "PL": "PL",
    "Tschechien": "CZ",
    "Czech Republic": "CZ",
    "CZ": "CZ",
  };
  return map[country] || country.toUpperCase().slice(0, 2);
}
