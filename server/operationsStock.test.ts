import { isolatedOperationsDatabase } from './operationsTestDatabase.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { previewStock, confirmStock, executeStock, stockStatus } from './operationsStock.js';
const enabled = process.env.OPS_ISOLATED_REHEARSAL === 'true';
test('isolated SQL: exact identity, confirmation, atomic history, replay, drift and fencing', { skip: !enabled }, async () => {
    process.env.OPS_STOCK_ENABLED = 'true';
    const pool = new pg.Pool({ connectionString: isolatedOperationsDatabase() });
    const actor = { id: randomUUID(), username: 'isolated-test', role: 'admin' as const };
    const sku = 'TEST-' + randomUUID().slice(0, 8);
    let id = 0;
    try {
        id = (await pool.query("INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible) VALUES($1,'Synthetic test',8,$1,1) RETURNING id", [sku])).rows[0].id;
        const input = { articleId: id, sku, shopProductId: sku, variantKey: '', targetStock: 12, reason: 'Isolated verification' };
        await assert.rejects(previewStock(pool, actor, { ...input, sku: 'wrong' }), /identity_mismatch/);
        const p = await previewStock(pool, actor, input);
        await assert.rejects(executeStock(pool, actor, { previewId: p.previewId }), /confirmation_required/);
        await assert.rejects(confirmStock(pool, actor, { previewId: p.previewId, confirmationSku: 'wrong' }), /confirmation_mismatch/);
        await confirmStock(pool, actor, { previewId: p.previewId, confirmationSku: sku });
        const results = await Promise.all([executeStock(pool, actor, { previewId: p.previewId }), executeStock(pool, actor, { previewId: p.previewId })]);
        assert(results.some(r => r.status === 'completed'));
        assert.equal((await pool.query('SELECT stock FROM articles WHERE id=$1', [id])).rows[0].stock, 12);
        assert.equal(Number((await pool.query('SELECT count(*) FROM stock_history WHERE article_id=$1', [id])).rows[0].count), 1);
        await pool.query("UPDATE ops_console_previews SET expires_at=now()-interval '1 minute' WHERE id=$1", [p.previewId]);
        assert.equal((await executeStock(pool, actor, { previewId: p.previewId })).status, 'completed');
        const stale = await previewStock(pool, actor, { ...input, targetStock: 15 });
        await confirmStock(pool, actor, { previewId: stale.previewId, confirmationSku: sku });
        await pool.query("UPDATE articles SET name='Changed' WHERE id=$1", [id]);
        assert.equal((await executeStock(pool, actor, { previewId: stale.previewId })).status, 'preview_stale');
        assert.equal((await pool.query('SELECT stock FROM articles WHERE id=$1', [id])).rows[0].stock, 12);
        const fence = await previewStock(pool, actor, input);
        await pool.query("INSERT INTO ops_console_receipts(id,preview_id,actor_id,target_id,state) VALUES($1,$2,$3,$4,'executing')", [fence.idempotencyKey, fence.previewId, actor.id, id]);
        await pool.query('INSERT INTO ops_console_fences(target_id,receipt_id) VALUES($1,$2)', [id, fence.idempotencyKey]);
        await assert.rejects(pool.query('UPDATE articles SET stock=99 WHERE id=$1', [id]), /ops_target_outcome_pending/);
        await pool.query('DELETE FROM ops_console_fences WHERE receipt_id=$1', [fence.idempotencyKey]);
        await pool.query("UPDATE ops_console_receipts SET created_at=now()-interval '1 minute' WHERE id=$1", [fence.idempotencyKey]);
        assert.equal((await stockStatus(pool, actor, { idempotencyKey: fence.idempotencyKey })).status, 'failed');
        const unknown = await previewStock(pool, actor, { ...input, targetStock: 14 });
        await confirmStock(pool, actor, { previewId: unknown.previewId, confirmationSku: sku });
        const connect = pool.connect.bind(pool);
        let commits = 0;
        (pool as any).connect = async () => { const c = await connect(); const query = c.query.bind(c); (c as any).query = async (...args: any[]) => { const r = await (query as any)(...args); if (args[0] === 'COMMIT' && ++commits === 2)
            throw Error('Simulated response lost after successful commit'); return r; }; return c; };
        const lost = await executeStock(pool, actor, { previewId: unknown.previewId });
        (pool as any).connect = connect;
        assert.equal(lost.status, 'outcome_unknown');
        assert.equal((await stockStatus(pool, actor, { idempotencyKey: unknown.idempotencyKey })).status, 'completed');
        assert.equal((await executeStock(pool, actor, { previewId: unknown.previewId })).status, 'completed');
        assert.equal(Number((await pool.query('SELECT count(*) FROM stock_history WHERE article_id=$1', [id])).rows[0].count), 2);
        await assert.rejects(pool.query('DELETE FROM ops_console_events WHERE actor_id=$1', [actor.id]), /ops_audit_append_only/);
    }
    finally {
        await pool.end();
    }
});

test('isolated concurrent distinct stock corrections preserve one winner and one conflict', { skip: !enabled }, async () => {
    process.env.OPS_STOCK_ENABLED = 'true';
    const pool = new pg.Pool({ connectionString: isolatedOperationsDatabase() });
    const actor = { id: randomUUID(), username: 'concurrent-test', role: 'admin' as const };
    const sku = 'TEST-RACE-' + randomUUID().slice(0, 8);
    try {
        const id = (await pool.query("INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible) VALUES($1,'Synthetic concurrency test',8,$1,1) RETURNING id", [sku])).rows[0].id;
        const input = { articleId: id, sku, shopProductId: sku, variantKey: '', reason: 'Isolated concurrency verification' };
        const previews = await Promise.all([previewStock(pool, actor, { ...input, targetStock: 17 }), previewStock(pool, actor, { ...input, targetStock: 18 })]);
        await Promise.all(previews.map(p => confirmStock(pool, actor, { previewId: p.previewId, confirmationSku: sku })));
        const outcomes = await Promise.allSettled(previews.map(p => executeStock(pool, actor, { previewId: p.previewId })));
        const winners = outcomes.filter(o => o.status === 'fulfilled' && o.value.status === 'completed');
        assert.equal(winners.length, 1, 'only one distinct correction may commit');
        const loser = outcomes.find(o => !(o.status === 'fulfilled' && o.value.status === 'completed'))!;
        if (loser.status === 'fulfilled') assert(['preview_stale', 'conflict'].includes(loser.value.status));
        else assert.equal(loser.reason.code, '23505', 'the competing target fence is rejected; API maps this to operation_conflict');
        const winnerIndex = outcomes.findIndex(o => o.status === 'fulfilled' && o.value.status === 'completed');
        const expectedStock = winnerIndex === 0 ? 17 : 18;
        assert.equal((await pool.query('SELECT stock FROM articles WHERE id=$1', [id])).rows[0].stock, expectedStock);
        const movements = (await pool.query('SELECT quantity_before,quantity_after FROM stock_history WHERE article_id=$1', [id])).rows;
        assert.equal(movements.length, 1);
        assert.equal(movements[0].quantity_before, 8);
        assert.equal(movements[0].quantity_after, expectedStock);
        assert.equal((await stockStatus(pool, actor, { idempotencyKey: previews[winnerIndex].idempotencyKey })).status, 'completed');
        assert.equal(Number((await pool.query('SELECT count(*) FROM ops_console_fences WHERE target_id=$1', [id])).rows[0].count), 0);
    } finally { await pool.end(); }
});
