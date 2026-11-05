import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { OpsActor } from './operationsAuth.js';
import { orderHash } from './jarvyOrderContract.js';
import { assertGlobalAutomaticDiscountConfigCanBeSaved, globalAutomaticDiscountConfigSchema, parseGlobalAutomaticDiscountConfig, getActiveGlobalAutomaticDiscount } from './globalAutomaticDiscountConfig.js';
function admin(a: OpsActor) { if (a.role !== 'admin')
    throw Error('role_denied'); if (process.env.OPS_PROMOTION_ENABLED !== 'true')
    throw Error('promotion_not_enabled'); }
export async function promotionCurrent(pool: Pool) { const r = await pool.query("SELECT value,updated_at FROM shop_settings WHERE key='global_automatic_discount'"); const config = parseGlobalAutomaticDiscountConfig(r.rows[0]?.value); return { config, active: getActiveGlobalAutomaticDiscount(config), serverTime: new Date().toISOString() }; }
export async function promotionPreview(pool: Pool, a: OpsActor, body: unknown) { admin(a); const config = globalAutomaticDiscountConfigSchema.strict().parse(body); if (config.startsAt && config.expiresAt && config.startsAt >= config.expiresAt)
    throw Error('invalid_period'); if (config.enabled && (!config.expiresAt || Date.parse(config.expiresAt) <= Date.now()))
    throw Error('expiry_required'); assertGlobalAutomaticDiscountConfigCanBeSaved(config); const before = await promotionCurrent(pool); const id = randomUUID(), key = randomUUID(); const { rows: [p] } = await pool.query("INSERT INTO ops_console_previews(id,actor_id,operation_type,target_id,target_sku,before_snapshot,planned_mutation,expected_hash,idempotency_key,expires_at) VALUES($1,$2,'promotion',0,'global_automatic_discount',$3,$4,$5,$6,now()+interval '5 minutes') RETURNING expires_at", [id, a.id, before.config, config, orderHash(before.config), key]); return { previewId: id, idempotencyKey: key, before: before.config, after: config, expiresAt: p.expires_at, confirmation: 'RABATTAKTION' }; }
export async function promotionExecute(pool: Pool, a: OpsActor, body: unknown) {
    admin(a);
    const i = z.object({ previewId: z.string().uuid(), confirmation: z.literal('RABATTAKTION') }).strict().parse(body);
    const c = await pool.connect();
    let commitStarted = false;
    let receiptId = '';
    try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout='3000ms'");
        const { rows: [p] } = await c.query("SELECT *,expires_at>now() AS fresh FROM ops_console_previews WHERE id=$1 AND actor_id=$2 AND operation_type='promotion' FOR UPDATE", [i.previewId, a.id]);
        if (!p)
            throw Error('preview_not_found');
        receiptId = p.idempotency_key;
        const old = (await c.query('SELECT state,result FROM ops_console_receipts WHERE id=$1', [p.idempotency_key])).rows[0];
        if (old) {
            await c.query('COMMIT');
            return { idempotencyKey: p.idempotency_key, status: old.state, result: old.result };
        }
        if (!p.fresh)
            throw Error('preview_stale');
        await c.query("SELECT pg_advisory_xact_lock(hashtext('global_automatic_discount'))");
        const { rows } = await c.query("SELECT value FROM shop_settings WHERE key='global_automatic_discount' FOR UPDATE");
        if (orderHash(parseGlobalAutomaticDiscountConfig(rows[0]?.value)) !== p.expected_hash)
            throw Error('preview_stale');
        await c.query("INSERT INTO ops_console_receipts(id,preview_id,actor_id,target_id,state) VALUES($1,$2,$3,0,'executing')", [p.idempotency_key, p.id, a.id]);
        await c.query("INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()", [JSON.stringify(p.planned_mutation)]);
        const result = { config: p.planned_mutation, active: getActiveGlobalAutomaticDiscount(p.planned_mutation), serverTime: new Date().toISOString() };
        await c.query("UPDATE ops_console_receipts SET state='completed',result=$2,completed_at=now() WHERE id=$1", [p.idempotency_key, result]);
        await c.query("UPDATE ops_console_previews SET status='completed',confirmed_at=now() WHERE id=$1", [p.id]);
        await c.query("INSERT INTO ops_console_events(receipt_id,actor_id,event_type,data) VALUES($1,$2,'promotion.completed',$3)", [p.idempotency_key, a.id, result]);
        commitStarted = true;
        await c.query('COMMIT');
        return { idempotencyKey: p.idempotency_key, status: 'completed', result };
    }
    catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        if (commitStarted)
            return { status: 'outcome_unknown', idempotencyKey: receiptId };
        throw e;
    }
    finally {
        c.release();
    }
}
