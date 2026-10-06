import { z } from "zod";
import { router, adminProcedure } from "./trpc.js";
import { getPool } from "./db.js";

const dateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  productName: z.string().trim().min(1).max(200).optional(),
});

const movementInputSchema = dateRangeSchema.extend({
  limit: z.number().int().min(1).max(1_000).default(500),
});

type SqlFilter = { where: string; params: Array<string> };

function buildOrderFilter(input: z.infer<typeof dateRangeSchema>): SqlFilter {
  const params = [input.from, input.to];
  let where = "o.order_date >= $1::date AND o.order_date < ($2::date + INTERVAL '1 day')";

  if (input.productName) {
    params.push(input.productName);
    where += ` AND EXISTS (
      SELECT 1 FROM order_items matching_item
      WHERE matching_item.order_id = o.order_id AND matching_item.name = $${params.length}
    )`;
  }

  return { where, params };
}

function commercialCondition(alias = "o"): string {
  return `${alias}.status <> 'storniert' AND COALESCE(${alias}.total::numeric, 0) > 0`;
}

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read-only, SQL-aggregated WaWi data. This intentionally has no mutation and
 * does not expose individual customer details. It replaces dashboard startup
 * full-table payloads while leaving every existing operational router intact.
 */
export const dashboardRouter = router({
  overview: adminProcedure
    .input(dateRangeSchema)
    .query(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const { where, params } = buildOrderFilter(input);
      const commercial = commercialCondition();

      const [periodResult, dailyResult, paymentResult, statusResult, globalResult, inventoryResult, lowStockResult, productNamesResult, shopStatusResult] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*)::int AS "orderCount",
            COALESCE(SUM(o.total::numeric), 0) AS "totalRevenue",
            COALESCE(SUM(o.discount::numeric), 0) AS "totalDiscount",
            COALESCE(SUM(o.shipping::numeric), 0) AS "totalShipping",
            COALESCE(AVG(o.total::numeric), 0) AS "avgOrderValue"
          FROM orders o
          WHERE ${where} AND ${commercial}
        `, params),
        pool.query(`
          SELECT
            TO_CHAR(o.order_date::date, 'YYYY-MM-DD') AS date,
            COUNT(*)::int AS count,
            COALESCE(SUM(o.total::numeric), 0) AS revenue
          FROM orders o
          WHERE ${where} AND ${commercial}
          GROUP BY o.order_date::date
          ORDER BY o.order_date::date ASC
        `, params),
        pool.query(`
          SELECT o.payment_method AS method, COUNT(*)::int AS count, COALESCE(SUM(o.total::numeric), 0) AS revenue
          FROM orders o
          WHERE ${where} AND ${commercial}
          GROUP BY o.payment_method
          ORDER BY revenue DESC
        `, params),
        pool.query(`
          SELECT o.status, COUNT(*)::int AS count
          FROM orders o
          WHERE ${where}
          GROUP BY o.status
        `, params),
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status <> 'storniert' AND COALESCE(total::numeric, 0) > 0)::int AS total,
            COUNT(*) FILTER (WHERE status = 'offen' AND COALESCE(total::numeric, 0) > 0)::int AS offen,
            COUNT(*) FILTER (WHERE status = 'bezahlt' AND COALESCE(total::numeric, 0) > 0)::int AS bezahlt,
            COUNT(*) FILTER (WHERE status = 'gepackt' AND COALESCE(total::numeric, 0) > 0)::int AS gepackt,
            COUNT(*) FILTER (WHERE status = 'versendet' AND COALESCE(total::numeric, 0) > 0)::int AS versendet,
            COUNT(*) FILTER (WHERE status = 'zugestellt' AND COALESCE(total::numeric, 0) > 0)::int AS zugestellt,
            COUNT(*) FILTER (WHERE status = 'storniert')::int AS storniert,
            COALESCE(SUM(total::numeric) FILTER (WHERE status IN ('bezahlt', 'gepackt', 'versendet', 'zugestellt') AND COALESCE(total::numeric, 0) > 0), 0) AS "umsatzBezahlt",
            COALESCE(SUM(total::numeric) FILTER (WHERE status = 'offen' AND COALESCE(total::numeric, 0) > 0), 0) AS "umsatzOffen"
          FROM orders
        `),
        pool.query(`
          SELECT
            COUNT(*)::int AS "totalArticles",
            COALESCE(SUM(stock), 0)::int AS "totalStock",
            COUNT(*) FILTER (WHERE stock < min_stock)::int AS "lowStockCount",
            COALESCE(SUM(COALESCE(purchase_price::numeric, 0) * stock), 0) AS "totalPurchaseValue",
            COALESCE(SUM(COALESCE(selling_price::numeric, 0) * stock), 0) AS "totalSellingValue"
          FROM articles
          WHERE is_active = 1
        `),
        pool.query(`
          SELECT id, sku, name, stock, min_stock AS "minStock", COALESCE(selling_price::numeric, 0) AS "sellingPrice"
          FROM articles
          WHERE is_active = 1 AND stock < min_stock
          ORDER BY stock ASC, name ASC
          LIMIT 100
        `),
        pool.query(`SELECT DISTINCT name FROM order_items ORDER BY name ASC LIMIT 1_000`),
        // The status is displayed in the WaWi dashboard header. Keeping this
        // small read in the aggregate response eliminates a second startup
        // request without changing the public shop-status endpoint.
        pool.query(`
          SELECT value, updated_at AS "updatedAt"
          FROM shop_settings
          WHERE key = 'shop_open'
          LIMIT 1
        `),
      ]);

      const [period] = periodResult.rows;
      const [global] = globalResult.rows;
      const [inventory] = inventoryResult.rows;
      const [shopStatus] = shopStatusResult.rows;
      const cancelledResult = await pool.query(`SELECT COUNT(*)::int AS count FROM orders o WHERE ${where} AND o.status = 'storniert'`, params);

      return {
        period: {
          orderCount: asNumber(period?.orderCount),
          cancelledCount: asNumber(cancelledResult.rows[0]?.count),
          totalRevenue: asNumber(period?.totalRevenue),
          totalDiscount: asNumber(period?.totalDiscount),
          totalShipping: asNumber(period?.totalShipping),
          avgOrderValue: asNumber(period?.avgOrderValue),
          netRevenue: asNumber(period?.totalRevenue) / 1.19,
          dailyData: dailyResult.rows.map((row) => ({ date: String(row.date), count: asNumber(row.count), revenue: asNumber(row.revenue) })),
          paymentBreakdown: paymentResult.rows.map((row) => ({ method: String(row.method || "Unbekannt"), count: asNumber(row.count), revenue: asNumber(row.revenue) })),
          statusBreakdown: statusResult.rows.map((row) => ({ status: String(row.status), count: asNumber(row.count) })),
        },
        global: {
          total: asNumber(global?.total),
          offen: asNumber(global?.offen),
          bezahlt: asNumber(global?.bezahlt),
          gepackt: asNumber(global?.gepackt),
          versendet: asNumber(global?.versendet),
          zugestellt: asNumber(global?.zugestellt),
          storniert: asNumber(global?.storniert),
          umsatzBezahlt: asNumber(global?.umsatzBezahlt),
          umsatzOffen: asNumber(global?.umsatzOffen),
        },
        inventory: {
          totalArticles: asNumber(inventory?.totalArticles),
          totalStock: asNumber(inventory?.totalStock),
          lowStockCount: asNumber(inventory?.lowStockCount),
          totalPurchaseValue: asNumber(inventory?.totalPurchaseValue),
          totalSellingValue: asNumber(inventory?.totalSellingValue),
          lowStockArticles: lowStockResult.rows.map((row) => ({
            id: asNumber(row.id), sku: String(row.sku), name: String(row.name), stock: asNumber(row.stock), minStock: asNumber(row.minStock), sellingPrice: asNumber(row.sellingPrice),
          })),
        },
        productNames: productNamesResult.rows.map((row) => String(row.name)),
        shopStatus: {
          shopOpen: shopStatus ? shopStatus.value === "true" : true,
          updatedAt: shopStatus?.updatedAt ? new Date(shopStatus.updatedAt).toISOString() : null,
        },
      };
    }),

  products: adminProcedure
    .input(dateRangeSchema)
    .query(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const { where, params } = buildOrderFilter(input);
      const result = await pool.query(`
        SELECT
          i.name,
          COALESCE(SUM(i.quantity), 0)::int AS quantity,
          COALESCE(SUM(i.price::numeric * i.quantity), 0) AS revenue,
          COUNT(*)::int AS "orderCount"
        FROM orders o
        JOIN order_items i ON i.order_id = o.order_id
        WHERE ${where} AND ${commercialCondition()} AND COALESCE(i.price::numeric, 0) > 0
        GROUP BY i.name
        ORDER BY revenue DESC, i.name ASC
      `, params);

      return result.rows.map((row) => ({
        name: String(row.name), quantity: asNumber(row.quantity), revenue: asNumber(row.revenue), orderCount: asNumber(row.orderCount),
      }));
    }),

  inventoryList: adminProcedure.query(async () => {
    const pool = await getPool();
    if (!pool) throw new Error("Database not available");
    const result = await pool.query(`
      SELECT id, sku, name, stock, min_stock AS "minStock", max_stock AS "maxStock",
        COALESCE(purchase_price::numeric, 0) AS "purchasePrice",
        COALESCE(selling_price::numeric, 0) AS "sellingPrice"
      FROM articles
      WHERE is_active = 1
      ORDER BY stock ASC, name ASC
    `);
    return result.rows.map((row) => ({
      id: asNumber(row.id), sku: String(row.sku), name: String(row.name), stock: asNumber(row.stock), minStock: asNumber(row.minStock), maxStock: row.maxStock === null ? null : asNumber(row.maxStock), purchasePrice: asNumber(row.purchasePrice), sellingPrice: asNumber(row.sellingPrice),
    }));
  }),

  stockMovements: adminProcedure
    .input(movementInputSchema)
    .query(async ({ input }) => {
      const pool = await getPool();
      if (!pool) throw new Error("Database not available");
      const result = await pool.query(`
        SELECT
          h.id, h.article_id AS "articleId", h.change_type AS type, h.quantity_change AS change,
          h.reason, h.order_id AS "orderId", h.user_name AS "userName", h.created_at AS "createdAt",
          COALESCE(a.name || ' (' || a.sku || ')', 'Artikel #' || h.article_id::text) AS "articleName"
        FROM stock_history h
        LEFT JOIN articles a ON a.id = h.article_id
        WHERE h.created_at >= $1::date AND h.created_at < ($2::date + INTERVAL '1 day')
        ORDER BY h.created_at DESC
        LIMIT $3
      `, [input.from, input.to, input.limit]);

      return result.rows.map((row) => ({
        id: asNumber(row.id), articleId: asNumber(row.articleId), type: String(row.type), change: asNumber(row.change), reason: row.reason ? String(row.reason) : null,
        orderId: row.orderId ? String(row.orderId) : null, userName: row.userName ? String(row.userName) : null,
        createdAt: new Date(row.createdAt).toISOString(), articleName: String(row.articleName),
      }));
    }),
});
