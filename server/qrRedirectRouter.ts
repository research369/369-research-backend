import { Router } from "express";
import { getPool } from "./db.js";
import {
  QR_ATTRIBUTION_DAYS,
  buildTrackedTarget,
  classifyDevice,
  createOpaqueToken,
  getCookie,
  hashIp,
} from "./qrCampaignService.js";

export const qrRedirectRouter = Router();

// Marketing namespace only. `/i/<token>` remains reserved for the 14,650
// prepared individual product/serial URLs and is intentionally not mounted here.
qrRedirectRouter.get("/r/:shortCode", async (req, res) => {
  try {
    const shortCode = String(req.params.shortCode || "").toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shortCode)) return res.status(404).send("QR-Code nicht gefunden");
    const pool = await getPool();
    if (!pool) return res.status(503).send("Service nicht verfügbar");

    const campaignResult = await pool.query(
      `SELECT id, name, short_code, target_url, campaign, medium
         FROM qr_campaigns
        WHERE LOWER(short_code) = $1 AND status = 'active' AND qr_type = 'marketing'
        LIMIT 1`,
      [shortCode],
    );
    if (campaignResult.rows.length === 0) return res.status(404).send("QR-Code nicht aktiv");
    const campaign = campaignResult.rows[0];

    const visitorCookie = getCookie(req, "qr_vid");
    const visitorId = visitorCookie && /^[a-f0-9]{48}$/.test(visitorCookie) ? visitorCookie : createOpaqueToken();
    const attributionToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + QR_ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000);
    const userAgent = String(req.headers["user-agent"] || "").slice(0, 2000);
    const forwardedIp = String(req.headers["x-forwarded-for"] || "").split(",")[0]?.trim();
    const country = String(req.headers["cf-ipcountry"] || req.headers["x-country"] || "").slice(0, 12) || null;
    const region = String(req.headers["x-region"] || req.headers["x-vercel-ip-country-region"] || country || "").slice(0, 120) || null;

    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO qr_attributions
          (attribution_token, campaign_id, visitor_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [attributionToken, campaign.id, visitorId, expiresAt],
      );
      await client.query(
        `INSERT INTO qr_scan_events
          (campaign_id, attribution_token, visitor_id, device_type, country_code, region, ip_hash, user_agent, referrer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          campaign.id,
          attributionToken,
          visitorId,
          classifyDevice(userAgent),
          country,
          region,
          hashIp(forwardedIp || req.ip || ""),
          userAgent || null,
          String(req.headers.referer || "").slice(0, 2000) || null,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const secure = req.secure || String(req.headers["x-forwarded-proto"]) === "https";
    const common = `Path=/; Max-Age=${QR_ATTRIBUTION_DAYS * 86400}; SameSite=Lax${secure ? "; Secure" : ""}`;
    res.append("Set-Cookie", `qr_attr=${encodeURIComponent(attributionToken)}; Domain=.369research.eu; ${common}`);
    if (!visitorCookie) res.append("Set-Cookie", `qr_vid=${encodeURIComponent(visitorId)}; Domain=.369research.eu; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`);
    res.set("Cache-Control", "no-store");
    return res.redirect(302, buildTrackedTarget(campaign.target_url, {
      shortCode: campaign.short_code,
      attributionToken,
      campaign: campaign.campaign,
      medium: campaign.medium,
    }));
  } catch (error) {
    console.error("[QR] Redirect tracking failed", error);
    return res.status(500).send("Weiterleitung derzeit nicht verfügbar");
  }
});
