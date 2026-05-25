/**
 * Sendcloud API Service v3
 * Handles label creation, tracking, and webhook processing
 * Uses Sendcloud API v3 /shipments endpoint (required for new accounts)
 * Zero-Risk-Mode: only writes to existing + additive optional fields
 */

import { createHmac } from "crypto";
import { ENV } from "./env.js";

const SENDCLOUD_API_V2_URL = "https://panel.sendcloud.sc/api/v2";
const SENDCLOUD_API_V3_URL = "https://panel.sendcloud.sc/api/v3";

// Shipping option codes for v3 API (account-specific, fetched dynamically)
// Fallback defaults for DHL Germany
const DEFAULT_SHIPPING_OPTION_DE = "dhl_de:dhl_paket";
const DEFAULT_SHIPPING_OPTION_EU = "dhl_de:dhl_paket";

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
 * Poll Sendcloud v2 parcel endpoint until label is ready (max 30s)
 */
async function waitForLabel(
  parcelId: number,
  credentials: string,
  maxWaitMs = 30000
): Promise<{
  trackingNumber: string;
  trackingUrl: string;
  labelUrl: string;
} | null> {
  const pollInterval = 2000;
  const maxAttempts = Math.ceil(maxWaitMs / pollInterval);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    try {
      const response = await fetch(
        `${SENDCLOUD_API_V2_URL}/parcels/${parcelId}`,
        {
          headers: {
            Authorization: `Basic ${credentials}`,
          },
        }
      );

      if (!response.ok) continue;

      const data = (await response.json()) as {
        parcel: {
          tracking_number: string;
          tracking_url: string;
          label: {
            normal_printer: string[];
            label_printer: string;
          };
          status: { id: number; message: string };
        };
      };

      const parcel = data.parcel;
      const labelUrl =
        parcel.label?.normal_printer?.[0] ||
        parcel.label?.label_printer ||
        null;

      // Status >= 1000 = label ready / ready to send
      if (parcel.tracking_number && labelUrl) {
        return {
          trackingNumber: parcel.tracking_number,
          trackingUrl: parcel.tracking_url || "",
          labelUrl,
        };
      }
    } catch {
      // Continue polling
    }
  }

  return null;
}

/**
 * Create a Sendcloud shipment using API v3 and get a shipping label
 * Uses async announcement + polling for label retrieval
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

  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString(
    "base64"
  );
  const countryCode = normalizeCountryCode(params.country);
  const shippingOptionCode = getShippingOptionCode(countryCode);
  const weight = (params.weightKg || 1.0).toFixed(3);

  // Build address_line_1: street + house number combined
  const addressLine1 = params.houseNumber
    ? `${params.street} ${params.houseNumber}`.trim()
    : params.street;

  const shipmentBody = {
    to_address: {
      name: `${params.firstName} ${params.lastName}`.trim(),
      company_name: params.company || undefined,
      address_line_1: addressLine1,
      city: params.city,
      postal_code: params.zip,
      country_code: countryCode,
      email: params.email || undefined,
      phone_number: params.phone || undefined,
    },
    from_address: {
      name: ENV.senderName || "369 Research",
      address_line_1: ENV.senderStreet
        ? `${ENV.senderStreet} ${ENV.senderHouseNumber || ""}`.trim()
        : undefined,
      city: ENV.senderCity || undefined,
      postal_code: ENV.senderZip || undefined,
      country_code: ENV.senderCountry || "DE",
    },
    ship_with: {
      type: "shipping_option_code",
      properties: {
        shipping_option_code: shippingOptionCode,
      },
    },
    parcels: [
      {
        weight: { value: weight, unit: "kg" },
        order_number: params.orderId,
        request_label: true,
      },
    ],
  };

  try {
    const response = await fetch(`${SENDCLOUD_API_V3_URL}/shipments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(shipmentBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[Sendcloud v3] API error:", response.status, errorBody);

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

    const data = (await response.json()) as {
      data: {
        id: string;
        parcels: Array<{
          id: number;
          tracking_number: string;
          tracking_url: string | null;
          status: { code: string; message: string };
          label?: {
            normal_printer?: string[];
            label_printer?: string;
          };
        }>;
      };
    };

    const shipment = data.data;
    const parcel = shipment?.parcels?.[0];

    if (!parcel) {
      return {
        success: false,
        errorCode: "SENDCLOUD_API_ERROR",
        errorMessage: "No parcel in Sendcloud response",
      };
    }

    const parcelId = parcel.id;

    // Check if label is immediately available
    const immediateLabel =
      parcel.label?.normal_printer?.[0] ||
      parcel.label?.label_printer ||
      null;

    if (parcel.tracking_number && immediateLabel) {
      return {
        success: true,
        parcelId,
        trackingNumber: parcel.tracking_number,
        trackingUrl: parcel.tracking_url || "",
        labelUrl: immediateLabel,
      };
    }

    // Label not yet ready — poll v2 parcels endpoint
    console.log(
      `[Sendcloud v3] Parcel ${parcelId} status: ${parcel.status?.message}. Polling for label...`
    );
    const labelData = await waitForLabel(parcelId, credentials);

    if (labelData) {
      return {
        success: true,
        parcelId,
        trackingNumber: labelData.trackingNumber,
        trackingUrl: labelData.trackingUrl,
        labelUrl: labelData.labelUrl,
      };
    }

    // Label still not ready after polling — return partial success
    console.warn(
      `[Sendcloud v3] Label for parcel ${parcelId} not ready after polling`
    );
    return {
      success: true,
      parcelId,
      trackingNumber: parcel.tracking_number || "",
      trackingUrl: parcel.tracking_url || "",
      labelUrl: "",
      errorMessage: "Label wird noch generiert — bitte in Sendcloud prüfen",
    };
  } catch (err: any) {
    console.error("[Sendcloud v3] Network error:", err.message);
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
 * Get Sendcloud v3 shipping option code based on destination country
 * Configure via SENDCLOUD_SHIPPING_OPTION_DE / SENDCLOUD_SHIPPING_OPTION_EU env vars
 */
function getShippingOptionCode(countryCode: string): string {
  if (countryCode === "DE") {
    return (
      (ENV as any).sendcloudShippingOptionDe ||
      process.env.SENDCLOUD_SHIPPING_OPTION_DE ||
      DEFAULT_SHIPPING_OPTION_DE
    );
  }
  return (
    (ENV as any).sendcloudShippingOptionEu ||
    process.env.SENDCLOUD_SHIPPING_OPTION_EU ||
    DEFAULT_SHIPPING_OPTION_EU
  );
}

/**
 * Normalize country string to ISO 2-letter code
 */
function normalizeCountryCode(country: string): string {
  const map: Record<string, string> = {
    Deutschland: "DE",
    Germany: "DE",
    DE: "DE",
    Österreich: "AT",
    Austria: "AT",
    AT: "AT",
    Schweiz: "CH",
    Switzerland: "CH",
    CH: "CH",
    Niederlande: "NL",
    Netherlands: "NL",
    NL: "NL",
    Frankreich: "FR",
    France: "FR",
    FR: "FR",
    Belgien: "BE",
    Belgium: "BE",
    BE: "BE",
    Luxemburg: "LU",
    Luxembourg: "LU",
    LU: "LU",
    Polen: "PL",
    Poland: "PL",
    PL: "PL",
    Tschechien: "CZ",
    "Czech Republic": "CZ",
    CZ: "CZ",
  };
  return map[country] || country.toUpperCase().slice(0, 2);
}
