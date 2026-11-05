import { isolatedOperationsDatabase } from './operationsTestDatabase.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { promotionPreview, promotionExecute, promotionCurrent } from './operationsPromotion.js';
import { getActiveGlobalAutomaticDiscount, defaultGlobalAutomaticDiscountConfig } from './globalAutomaticDiscountConfig.js';
test('global action uses server start and expiry', () => { const config = { ...defaultGlobalAutomaticDiscountConfig, enabled: true, percentage: 20, startsAt: '2026-10-13T10:00:00Z', expiresAt: '2026-10-13T11:00:00Z' }; assert.equal(getActiveGlobalAutomaticDiscount(config, new Date('2026-10-13T09:59:59Z')), null); assert.equal(getActiveGlobalAutomaticDiscount(config, new Date(config.startsAt))?.percentage, 20); assert.equal(getActiveGlobalAutomaticDiscount(config, new Date(config.expiresAt)), null); });
test('isolated action: admin, expiry, drift and idempotent execution', { skip: process.env.OPS_ISOLATED_REHEARSAL !== 'true' }, async () => { process.env.OPS_PROMOTION_ENABLED = 'true'; const pool = new pg.Pool({ connectionString: isolatedOperationsDatabase() }); const actor = { id: randomUUID(), username: 'test', role: 'admin' as const }; const config = { ...defaultGlobalAutomaticDiscountConfig, enabled: true, percentage: 20, expiresAt: new Date(Date.now() + 3600000).toISOString() }; try {
    await assert.rejects(promotionPreview(pool, { ...actor, role: 'viewer' }, config), /role_denied/);
    const p = await promotionPreview(pool, actor, config);
    await assert.rejects(promotionExecute(pool, actor, { previewId: p.previewId, confirmation: 'wrong' }));
    const r = await promotionExecute(pool, actor, { previewId: p.previewId, confirmation: 'RABATTAKTION' });
    assert.equal(r.status, 'completed');
    assert.equal((await promotionExecute(pool, actor, { previewId: p.previewId, confirmation: 'RABATTAKTION' })).status, 'completed');
    assert.equal((await promotionCurrent(pool)).active?.percentage, 20);
    const stale = await promotionPreview(pool, actor, { ...config, percentage: 25 });
    await pool.query("UPDATE shop_settings SET value=$1 WHERE key='global_automatic_discount'", [JSON.stringify({ ...config, percentage: 30 })]);
    await assert.rejects(promotionExecute(pool, actor, { previewId: stale.previewId, confirmation: 'RABATTAKTION' }), /preview_stale/);
}
finally {
    await pool.end();
} });
