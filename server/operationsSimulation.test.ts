import { isolatedOperationsDatabase } from './operationsTestDatabase.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool, closeDb, withReadOnlyDatabase } from './db.js';
import { searchOperations } from './operationsSearch.js';
import { simulateCheckout } from './operationsSimulation.js';
test('isolated canonical simulation: discount and stock, no writes or external calls', { skip: process.env.OPS_ISOLATED_REHEARSAL !== 'true' }, async () => {
    assert.equal(process.env.DATABASE_URL, isolatedOperationsDatabase());
    const pool = await getPool();
    assert(pool);
    const family = 'sim-' + randomUUID().slice(0, 8);
    const sku = family + '-10';
    const id = (await pool.query("INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category) VALUES($1,'Test (10 mg)',7,$2,1,100,'Zubehör') RETURNING id", [sku, family])).rows[0].id;
    await pool.query('UPDATE articles SET variants=$2 WHERE id=$1', [id, JSON.stringify([{ dosage: '10 mg', price: 100, inventoryArticleId: id, sku }])]);
    await pool.query("INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify({ enabled: true, percentage: 20, expiresAt: null, stackWithPromotionCodes: true, labelDe: 'Testaktion', labelEn: 'Test discount' })]);
    const before = (await pool.query('SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS history')).rows[0];
    for (const kind of ['articles', 'orders', 'customers', 'partners'] as const) {
        const r = await searchOperations({ q: 'Synthetic', kind });
        assert(Array.isArray(r.results));
    }
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw Error('External call forbidden'); };
    try {
        const r = await simulateCheckout({ items: [{ articleId: id, sku, shopProductId: family, variantKey: '10 mg', quantity: 2 }], country: 'Deutschland' }, {} as any, {} as any);
        assert.equal(r.subtotal, 200);
        assert.equal(r.discount, 40);
        assert.equal(r.shipping, 8);
        assert.equal(r.total, 168);
        assert.equal(r.available, true);
        assert.equal(r.sideEffects, false);
        assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM stock_history) AS history')).rows[0], before);
        assert.equal((await pool.query('SELECT stock FROM articles WHERE id=$1', [id])).rows[0].stock, 7);
        await assert.rejects(withReadOnlyDatabase(async () => { const p = await getPool(); await p!.query('UPDATE articles SET stock=99 WHERE id=$1', [id]); }), /read-only transaction/);
    }
    finally {
        globalThis.fetch = original;
        await closeDb();
    }
});
