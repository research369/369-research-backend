import { z } from 'zod';
import { getPool } from './db.js';
export async function searchOperations(body: unknown) {
    const i = z.object({ q: z.string().trim().min(2).max(100), kind: z.enum(['articles', 'orders', 'customers', 'partners']), page: z.number().int().min(1).max(500).default(1) }).strict().parse(body);
    const pool = await getPool();
    if (!pool)
        throw Error('unavailable');
    const c = await pool.connect();
    const pattern = '%' + i.q.replace(/[\\%_]/g, '\\$&') + '%';
    try {
        await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await c.query("SET LOCAL statement_timeout='5000ms'");
        const queries = { articles: `SELECT id,sku,name,stock,shop_product_id,is_active FROM articles WHERE sku ILIKE $1 OR name ILIKE $1 OR id::text=$2 OR shop_product_id ILIKE $1 ORDER BY id DESC LIMIT 51 OFFSET $3`, orders: `SELECT order_id,status,total,order_date,concat_ws(' ',first_name,last_name) AS customer_name FROM orders WHERE order_id ILIKE $1 OR concat_ws(' ',first_name,last_name) ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR id::text=$2 ORDER BY id DESC LIMIT 51 OFFSET $3`, customers: `SELECT id,name,email,phone FROM customers WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR id::text=$2 ORDER BY id DESC LIMIT 51 OFFSET $3`, partners: `SELECT id,name,partner_number,code,is_active FROM partners WHERE name ILIKE $1 OR partner_number ILIKE $1 OR code ILIKE $1 OR id::text=$2 ORDER BY id DESC LIMIT 51 OFFSET $3` };
        const r = await c.query(queries[i.kind], [pattern, i.q, (i.page - 1) * 50]);
        await c.query('COMMIT');
        return { kind: i.kind, results: r.rows.slice(0, 50), hasMore: r.rows.length > 50, page: i.page, observedAt: new Date().toISOString() };
    }
    catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        throw e;
    }
    finally {
        c.release();
    }
}
