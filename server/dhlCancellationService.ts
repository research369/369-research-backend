import { ENV } from "./env.js";

export interface DhlCancellationResult {
  outcome: "cancelled" | "rejected" | "unknown" | "manifested" | "delivered";
  statusCode?: number;
  error?: string;
}

/** Official v2.4 ordersAccountDelete / LabelDataResponse. No guessed DELETE body. */
export async function cancelDhlShipment(trackingNumber: string): Promise<DhlCancellationResult> {
  if (!ENV.dhlApiKey || !ENV.dhlBusinessUsername || !ENV.dhlBusinessPassword) {
    return { outcome: "rejected", error: "DHL-Konfiguration unvollständig" };
  }
  const base = ENV.dhlSandbox ? "https://api-sandbox.dhl.com" : "https://api-eu.dhl.com";
  const url = new URL(`${base}/parcel/de/shipping/v2/orders`);
  url.searchParams.set("profile", "STANDARD_GRUPPENPROFIL");
  url.searchParams.set("shipment", trackingNumber);
  let response: Response;
  let data: any;
  try {
    response = await fetch(url, {
      method: "DELETE",
      headers: {
        "dhl-api-key": ENV.dhlApiKey,
        Authorization: `Basic ${Buffer.from(`${ENV.dhlBusinessUsername}:${ENV.dhlBusinessPassword}`).toString("base64")}`,
        Accept: "application/json",
        "Accept-Language": "de-DE",
      },
      signal: AbortSignal.timeout(30_000),
    });
    data = await response.json();
  } catch {
    return { outcome: "unknown", error: "DHL-Stornoergebnis unbekannt. Extern prüfen; nicht erneut buchen oder stornieren." };
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  const item = items.find((value: any) => value.shipmentNo === trackingNumber);
  // A successful envelope alone is not proof; require the exact shipment's status.
  if ((response.status === 200 || response.status === 207) && items.length === 1 && item?.sstatus?.status === 200) {
    return { outcome: "cancelled", statusCode: response.status };
  }
  const detail = [item?.sstatus?.detail,item?.sstatus?.title,data?.status?.detail,data?.detail,data?.title,...(item?.validationMessages??[]).map((v:any)=>v.validationMessage)].filter(Boolean).join("; ").slice(0,500) || "DHL hat die Stornierung nicht bestätigt";
  if (/delivered|zugestellt/i.test(detail)) {
    return { outcome: "delivered", statusCode: response.status, error: detail };
  }
  if (/manifest|tagesabschluss|closed[ -]?out|bereits.*abgeschlossen/i.test(detail)) {
    return { outcome: "manifested", statusCode: response.status, error: detail };
  }
  // 400 also means nonexistent/already deleted, NOT a cancellation confirmation.
  if ([400, 401, 403, 404, 409, 422, 429].includes(response.status) || item?.sstatus?.status === 400) {
    return { outcome: "rejected", statusCode: response.status, error: detail };
  }
  return { outcome: "unknown", statusCode: response.status, error: detail };
}
