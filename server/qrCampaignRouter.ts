import QRCode from "qrcode";
import { z } from "zod";
import { adminProcedure, publicProcedure, router } from "./trpc.js";
import { getPool } from "./db.js";
import { QR_PUBLIC_BASE_URL, resolveQrAttribution } from "./qrCampaignService.js";

const shortCodeSchema = z.string().trim().toLowerCase().min(3).max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Nur Kleinbuchstaben, Zahlen und Bindestriche verwenden")
  .refine((value) => value !== "i" && !value.startsWith("i-"), "Der Bereich i ist für Produkt-/Seriennummern reserviert");

const targetUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
}, "Nur sichere HTTPS-Zielseiten sind zulässig");

const campaignInput = z.object({
  name: z.string().trim().min(2).max(160),
  shortCode: shortCodeSchema,
  targetUrl: targetUrlSchema,
  campaign: z.string().trim().max(160).optional().nullable(),
  medium: z.string().trim().max(100).optional().nullable(),
  locationPartner: z.string().trim().max(200).optional().nullable(),
  status: z.enum(["active", "inactive", "archived"]).default("active"),
});

const money = (value: unknown) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

export const qrCampaignRouter = router({
  list: adminProcedure.query(async () => {
    const pool = await getPool();
    if (!pool) throw new Error("Database not available");
    const result = await pool.query(`
      WITH scan_stats AS (
        SELECT campaign_id, COUNT(*)::int scans, COUNT(DISTINCT visitor_id)::int unique_visitors
          FROM qr_scan_events GROUP BY campaign_id
      ), cart_stats AS (
        SELECT campaign_id, COUNT(*)::int carts FROM qr_cart_events GROUP BY campaign_id
      ), order_stats AS (
        SELECT qr_campaign_id campaign_id,
          COUNT(*) FILTER (WHERE status <> 'storniert')::int orders,
          COALESCE(SUM(total::numeric) FILTER (WHERE status IN ('bezahlt','gepackt','versendet','zugestellt','abgeholt')),0) revenue
          FROM orders WHERE qr_campaign_id IS NOT NULL GROUP BY qr_campaign_id
      )
      SELECT c.*, COALESCE(s.scans,0) scans, COALESCE(s.unique_visitors,0) unique_visitors,
        COALESCE(ce.carts,0) carts, COALESCE(o.orders,0) orders, COALESCE(o.revenue,0) revenue
      FROM qr_campaigns c
      LEFT JOIN scan_stats s ON s.campaign_id=c.id
      LEFT JOIN cart_stats ce ON ce.campaign_id=c.id
      LEFT JOIN order_stats o ON o.campaign_id=c.id
      ORDER BY c.created_at DESC
    `);
    return result.rows.map((row) => {
      const scans = Number(row.scans || 0);
      const visitors = Number(row.unique_visitors || 0);
      const orders = Number(row.orders || 0);
      const revenue = money(row.revenue);
      return {
        id: row.id,
        name: row.name,
        shortCode: row.short_code,
        targetUrl: row.target_url,
        campaign: row.campaign,
        medium: row.medium,
        locationPartner: row.location_partner,
        status: row.status,
        dynamicUrl: `${QR_PUBLIC_BASE_URL}/r/${row.short_code}`,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        scans,
        uniqueVisitors: visitors,
        carts: Number(row.carts || 0),
        orders,
        revenue,
        conversionRate: visitors > 0 ? money(orders / visitors * 100) : 0,
        revenuePer100Scans: scans > 0 ? money(revenue / scans * 100) : 0,
      };
    });
  }),

  create: adminProcedure.input(campaignInput).mutation(async ({ input, ctx }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Database not available");
    try {
      const result = await pool.query(
        `INSERT INTO qr_campaigns
          (name, short_code, target_url, campaign, medium, location_partner, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id`,
        [input.name, input.shortCode, input.targetUrl, input.campaign || null, input.medium || null,
          input.locationPartner || null, input.status, ctx.user?.name || ctx.user?.username || "admin"],
      );
      return { id: result.rows[0].id, dynamicUrl: `${QR_PUBLIC_BASE_URL}/r/${input.shortCode}` };
    } catch (error: any) {
      if (error?.code === "23505") throw new Error("Dieser Kurzcode ist bereits vergeben");
      throw error;
    }
  }),

  update: adminProcedure.input(campaignInput.partial().extend({ id: z.number().int().positive() })).mutation(async ({ input }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Database not available");
    const fields: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown) => { values.push(value); fields.push(`${column} = $${values.length}`); };
    if (input.name !== undefined) put("name", input.name);
    if (input.shortCode !== undefined) put("short_code", input.shortCode);
    if (input.targetUrl !== undefined) put("target_url", input.targetUrl);
    if (input.campaign !== undefined) put("campaign", input.campaign || null);
    if (input.medium !== undefined) put("medium", input.medium || null);
    if (input.locationPartner !== undefined) put("location_partner", input.locationPartner || null);
    if (input.status !== undefined) put("status", input.status);
    if (fields.length === 0) return { success: true };
    values.push(input.id);
    try {
      await pool.query(`UPDATE qr_campaigns SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length}`, values);
      return { success: true };
    } catch (error: any) {
      if (error?.code === "23505") throw new Error("Dieser Kurzcode ist bereits vergeben");
      throw error;
    }
  }),

  qrAsset: adminProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ input }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Database not available");
    const result = await pool.query("SELECT short_code FROM qr_campaigns WHERE id = $1 LIMIT 1", [input.id]);
    if (result.rows.length === 0) throw new Error("QR-Code nicht gefunden");
    const dynamicUrl = `${QR_PUBLIC_BASE_URL}/r/${result.rows[0].short_code}`;
    const [pngDataUrl, svg] = await Promise.all([
      QRCode.toDataURL(dynamicUrl, { width: 1200, margin: 2, errorCorrectionLevel: "M" }),
      QRCode.toString(dynamicUrl, { type: "svg", margin: 2, errorCorrectionLevel: "M" }),
    ]);
    return { dynamicUrl, pngDataUrl, svg };
  }),

  timeline: adminProcedure.input(z.object({ id: z.number().int().positive(), days: z.number().int().min(7).max(365).default(30) })).query(async ({ input }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Database not available");
    const result = await pool.query(
      `WITH days AS (
         SELECT generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, '1 day')::date AS day
       )
       SELECT d.day,
         (SELECT COUNT(*)::int FROM qr_scan_events s WHERE s.campaign_id=$1 AND s.scanned_at::date=d.day) scans,
         (SELECT COUNT(DISTINCT visitor_id)::int FROM qr_scan_events s WHERE s.campaign_id=$1 AND s.scanned_at::date=d.day) visitors,
         (SELECT COUNT(*)::int FROM qr_cart_events c WHERE c.campaign_id=$1 AND c.occurred_at::date=d.day) carts,
         (SELECT COUNT(*)::int FROM orders o WHERE o.qr_campaign_id=$1 AND o.order_date::date=d.day AND o.status<>'storniert') orders,
         (SELECT COALESCE(SUM(o.total::numeric),0) FROM orders o WHERE o.qr_campaign_id=$1 AND o.order_date::date=d.day
            AND o.status IN ('bezahlt','gepackt','versendet','zugestellt','abgeholt')) revenue
       FROM days d ORDER BY d.day`,
      [input.id, input.days],
    );
    return result.rows.map((row) => ({ date: row.day, scans: Number(row.scans), visitors: Number(row.visitors), carts: Number(row.carts), orders: Number(row.orders), revenue: money(row.revenue) }));
  }),

  breakdown: adminProcedure.input(z.object({ id: z.number().int().positive(), days: z.number().int().min(1).max(365).default(30) })).query(async ({ input }) => {
    const pool = await getPool();
    if (!pool) throw new Error("Database not available");
    const [devices, regions] = await Promise.all([
      pool.query(`SELECT COALESCE(device_type,'unknown') label, COUNT(*)::int value FROM qr_scan_events WHERE campaign_id=$1 AND scanned_at >= NOW()-($2::int*INTERVAL '1 day') GROUP BY 1 ORDER BY 2 DESC`, [input.id, input.days]),
      pool.query(`SELECT COALESCE(NULLIF(region,''),COALESCE(country_code,'Unbekannt')) label, COUNT(*)::int value FROM qr_scan_events WHERE campaign_id=$1 AND scanned_at >= NOW()-($2::int*INTERVAL '1 day') GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [input.id, input.days]),
    ]);
    return { devices: devices.rows, regions: regions.rows };
  }),

  trackCart: publicProcedure.input(z.object({ attributionToken: z.string().length(48) })).mutation(async ({ input }) => {
    const attribution = await resolveQrAttribution(input.attributionToken);
    if (!attribution) return { tracked: false };
    const pool = await getPool();
    if (!pool) throw new Error("Database not available");
    await pool.query(
      `INSERT INTO qr_cart_events (campaign_id, attribution_token, visitor_id)
       SELECT campaign_id, attribution_token, visitor_id FROM qr_attributions WHERE attribution_token=$1
       ON CONFLICT (attribution_token) DO NOTHING`,
      [input.attributionToken],
    );
    return { tracked: true };
  }),
});
