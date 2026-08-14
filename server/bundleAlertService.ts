import { ENV } from "./env.js";
import { getDb } from "./db.js";
import { shopSettings } from "../drizzle/schema.js";
import { eq } from "drizzle-orm";

const RESEND_API_URL = "https://api.resend.com/emails";

/** Sends an operational alert only when the public bundle endpoint has actually failed. */
export async function notifyBundleFailure(error: unknown): Promise<void> {
  const db = await getDb();
  const [recipientSetting] = db
    ? await db.select().from(shopSettings).where(eq(shopSettings.key, "bundle_monitor_alert_recipient")).limit(1)
    : [];
  const recipient = recipientSetting?.value;
  if (!ENV.resendApiKey || !recipient) {
    console.error("[bundle-alert] Missing RESEND_API_KEY or bundle_monitor_alert_recipient", error);
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  try {
    await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${ENV.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "369 Research Monitor <noreply@coreversand.de>",
        reply_to: "support@369research.eu",
        to: [recipient],
        subject: "⚠️ Bundle-Katalog nicht verfügbar",
        html: `<p><strong>Der öffentliche Bundle-Endpunkt ist fehlgeschlagen.</strong></p><p>Fehler: ${reason.replace(/[<>]/g, "")}</p><p>Bitte Railway und die Bundle-Daten prüfen.</p>`,
      }),
    });
  } catch (alertError) {
    console.error("[bundle-alert] Could not send alert", alertError);
  }
}
