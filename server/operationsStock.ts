import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { orderHash } from './jarvyOrderContract.js';
import type { OpsActor } from './operationsAuth.js';
import { applyStockMovement } from './stockMovementService.js';
export const stockPreviewSchema = z.object({ articleId: z.number().int().positive(), sku: z.string().min(1).max(50), shopProductId: z.string().min(1).max(100).nullable(), variantKey: z.string().max(100), targetStock: z.number().int().min(0).max(2147483647), reason: z.string().trim().min(2).max(500) }).strict();
const norm = (v: string) => v.trim().toLowerCase().replace(/(\d)\s*(mg|iu|ml|mcg)\b/g, '$1 $2');
async function state(c: PoolClient, input: z.infer<typeof stockPreviewSchema>, lock = false) {
    const rows = (await c.query(`SELECT id,sku,name,shop_product_id,stock,is_active,shop_visible,selling_price,sale_price,variants,ops_version FROM articles WHERE ($1::text IS NOT NULL AND shop_product_id=$1) OR ($1::text IS NULL AND id=$2 AND sku=$3) ORDER BY id ${lock ? 'FOR UPDATE' : ''}`, [input.shopProductId, input.articleId, input.sku])).rows;
    const target = rows.find(a => a.id === input.articleId && a.sku === input.sku);
    if (!target || target.is_active !== 1)
        throw Error('identity_mismatch');
    const parents = rows.filter(a => a.shop_visible === 1 && a.is_active === 1 && Array.isArray(a.variants) && a.variants.length > 0);
    if (parents.length > 1)
        throw Error('identity_ambiguous');
    if (parents.length) {
        const variants = parents[0].variants.filter((v: any) => norm(String(v.dosage ?? v.label ?? v.name ?? '')) === norm(input.variantKey));
        if (variants.length !== 1 || Number(variants[0].inventoryArticleId) !== target.id || (variants[0].sku && variants[0].sku !== target.sku))
            throw Error('identity_mismatch');
    }
    else if (input.variantKey !== '')
        throw Error('identity_mismatch');
    const settings = (await c.query("SELECT key,value,updated_at FROM shop_settings WHERE key IN ('global_automatic_discount','smart_substitution_enabled','shop_open') ORDER BY key")).rows;
    const substitution = (await c.query('SELECT id,enabled,updated_at FROM substitution_config WHERE id=1')).rows;
    return { target, family: rows, settings, substitution, variantKey: input.variantKey };
}
function allow(actor: OpsActor) { if (!['operator', 'admin'].includes(actor.role))
    throw Error('role_denied'); if (process.env.OPS_STOCK_ENABLED !== 'true')
    throw Error('stock_not_enabled'); }
export async function previewStock(pool: Pool, actor: OpsActor, body: unknown) {
    allow(actor);
    const input = stockPreviewSchema.parse(body);
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        await c.query("SET LOCAL statement_timeout='5000ms'");
        const snapshot = await state(c, input, true);
        const id = randomUUID(), key = randomUUID();
        const { rows: [record] } = await c.query(`INSERT INTO ops_console_previews(id,actor_id,operation_type,target_id,target_sku,before_snapshot,planned_mutation,expected_hash,idempotency_key,expires_at) VALUES($1,$2,'stock_set',$3,$4,$5,$6,$7,$8,now()+interval '5 minutes') RETURNING created_at,expires_at`, [id, actor.id, input.articleId, input.sku, snapshot, input, orderHash(snapshot), key]);
        await c.query('INSERT INTO ops_console_events(preview_id,actor_id,event_type,data) VALUES($1,$2,$3,$4)', [id, actor.id, 'stock.preview', { articleId: input.articleId, sku: input.sku }]);
        await c.query('COMMIT');
        return { previewId: id, idempotencyKey: key, status: 'ready_for_confirmation', expiresAt: record.expires_at, before: snapshot.target, after: { ...snapshot.target, stock: input.targetStock }, variantKey: input.variantKey, reason: input.reason, sideEffects: ['Eine Bestandskorrektur und ein Auditereignis. Keine Bestellung oder Nachricht.'] };
    }
    catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        throw e;
    }
    finally {
        c.release();
    }
}
export async function confirmStock(pool: Pool, actor: OpsActor, body: unknown) {
    allow(actor);
    const i = z.object({ previewId: z.string().uuid(), confirmationSku: z.string().max(50) }).strict().parse(body);
    const r = await pool.query("UPDATE ops_console_previews SET confirmed_at=now() WHERE id=$1 AND actor_id=$2 AND operation_type='stock_set' AND target_sku=$3 AND status='ready_for_confirmation' AND expires_at>now() RETURNING id", [i.previewId, actor.id, i.confirmationSku]);
    if (!r.rowCount)
        throw Error('confirmation_mismatch');
    return { confirmed: true };
}
async function finalise(c: PoolClient, id: string, actor: OpsActor, status: string, result: unknown) {
    await c.query('UPDATE ops_console_receipts SET state=$2,result=$3,completed_at=now() WHERE id=$1', [id, status, result]);
    await c.query('UPDATE ops_console_previews SET status=$2 WHERE id=(SELECT preview_id FROM ops_console_receipts WHERE id=$1)', [id, status]);
    await c.query('INSERT INTO ops_console_events(receipt_id,actor_id,event_type,data) VALUES($1,$2,$3,$4)', [id, actor.id, 'stock.' + status, result]);
    await c.query('DELETE FROM ops_console_fences WHERE receipt_id=$1', [id]);
}
export async function executeStock(pool: Pool, actor: OpsActor, body: unknown) {
    allow(actor);
    const { previewId } = z.object({ previewId: z.string().uuid() }).strict().parse(body);
    const claim = await pool.connect();
    let receiptId = '';
    try {
        await claim.query('BEGIN');
        const { rows: [p] } = await claim.query('SELECT * FROM ops_console_previews WHERE id=$1 AND actor_id=$2 AND operation_type=\'stock_set\' FOR UPDATE', [previewId, actor.id]);
        if (!p)
            throw Error('preview_not_found');
        receiptId = p.idempotency_key;
        const old = (await claim.query('SELECT * FROM ops_console_receipts WHERE id=$1', [receiptId])).rows[0];
        if (old) {
            await claim.query('COMMIT');
            return { idempotencyKey: receiptId, status: old.state, result: old.result };
        }
        if (!p.confirmed_at)
            throw Error('confirmation_required');
        if (Date.parse(p.expires_at) <= Date.now())
            throw Error('preview_stale');
        await claim.query("INSERT INTO ops_console_receipts(id,preview_id,actor_id,target_id,state) VALUES($1,$2,$3,$4,'executing')", [receiptId, previewId, actor.id, p.target_id]);
        await claim.query('INSERT INTO ops_console_fences(target_id,receipt_id) VALUES($1,$2)', [p.target_id, receiptId]);
        await claim.query('COMMIT');
    }
    catch (e) {
        await claim.query('ROLLBACK').catch(() => { });
        throw e;
    }
    finally {
        claim.release();
    }
    const c = await pool.connect();
    let commitStarted = false;
    try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout='3000ms'");
        await c.query("SET LOCAL statement_timeout='8000ms'");
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [receiptId]);
        const { rows: [receipt] } = await c.query('SELECT * FROM ops_console_receipts WHERE id=$1 FOR UPDATE', [receiptId]);
        if (receipt.state !== 'executing') {
            await c.query('COMMIT');
            return { idempotencyKey: receiptId, status: receipt.state, result: receipt.result };
        }
        const { rows: [p] } = await c.query('SELECT *,expires_at>now() AS fresh FROM ops_console_previews WHERE id=$1 FOR UPDATE', [previewId]);
        if (!p.fresh)
            throw Error('preview_stale');
        const current = await state(c, p.planned_mutation, true);
        if (orderHash(current) !== p.expected_hash)
            throw Error('preview_stale');
        await c.query("SELECT set_config('ops.receipt_id',$1,true)", [receiptId]);
        const movement = await applyStockMovement(drizzle(c), { articleId: p.target_id, sku: p.target_sku, expectedStock: current.target.stock, change: p.planned_mutation.targetStock - current.target.stock, type: 'korrektur', reason: p.planned_mutation.reason, actor: 'console:' + actor.id });
        const after = (await c.query('SELECT id,sku,stock,ops_version FROM articles WHERE id=$1 AND sku=$2', [p.target_id, p.target_sku])).rows[0];
        const result = { before: current.target, after, movementId: movement.movementId };
        await finalise(c, receiptId, actor, 'completed', result);
        commitStarted = true;
        await c.query('COMMIT');
        return { idempotencyKey: receiptId, status: 'completed', result };
    }
    catch (e) {
        let rolledBack = false;
        try {
            await c.query('ROLLBACK');
            rolledBack = true;
        }
        catch { }
        if (!commitStarted && rolledBack) {
            const recover = await pool.connect();
            try {
                await recover.query('BEGIN');
                await recover.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [receiptId]);
                const r = (await recover.query('SELECT state FROM ops_console_receipts WHERE id=$1 FOR UPDATE', [receiptId])).rows[0];
                if (r.state === 'executing') {
                    const code = e instanceof Error && ['preview_stale', 'identity_mismatch', 'stock_conflict'].includes(e.message) ? e.message : 'conflict';
                    await finalise(recover, receiptId, actor, code, { code });
                    await recover.query('COMMIT');
                    return { idempotencyKey: receiptId, status: code };
                }
                await recover.query('COMMIT');
            }
            catch {
                await recover.query('ROLLBACK').catch(() => { });
            }
            finally {
                recover.release();
            }
        }
        return { idempotencyKey: receiptId, status: 'outcome_unknown' };
    }
    finally {
        c.release();
    }
}
export async function stockStatus(pool: Pool, actor: OpsActor, body: unknown) {
    const { idempotencyKey } = z.object({ idempotencyKey: z.string().uuid() }).strict().parse(body);
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const { rows: [r] } = await c.query('SELECT * FROM ops_console_receipts WHERE id=$1 AND actor_id=$2', [idempotencyKey, actor.id]);
        if (!r) {
            await c.query('COMMIT');
            return { status: 'not_found' };
        }
        if (r.state === 'executing' && Date.now() - Date.parse(r.created_at) > 30000) {
            const { rows: [lock] } = await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [idempotencyKey]);
            if (lock.acquired) {
                const current = (await c.query('SELECT * FROM ops_console_receipts WHERE id=$1 FOR UPDATE', [idempotencyKey])).rows[0];
                if (current.state === 'executing') {
                    await finalise(c, idempotencyKey, actor, 'failed', { code: 'interrupted_before_commit' });
                    r.state = 'failed';
                    r.result = { code: 'interrupted_before_commit' };
                }
                else {
                    r.state = current.state;
                    r.result = current.result;
                }
            }
        }
        await c.query('COMMIT');
        return { idempotencyKey, status: r.state === 'executing' ? 'outcome_unknown' : r.state, result: r.result };
    }
    catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        throw e;
    }
    finally {
        c.release();
    }
}
