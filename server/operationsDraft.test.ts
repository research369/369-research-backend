import { isolatedOperationsDatabase } from './operationsTestDatabase.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { draftSave, draftPreview, draftPublish, productDraftSchema, draftOptions } from './operationsDraft.js';
test('isolated product draft: 100 percent gate, atomic publish, zero initial stock, replay', { skip: process.env.OPS_ISOLATED_REHEARSAL !== 'true' }, async () => { process.env.OPS_PRODUCT_PUBLISH_ENABLED = 'true'; const pool = new pg.Pool({ connectionString: isolatedOperationsDatabase() }); const actor = { id: randomUUID(), username: 'test', role: 'admin' as const }; const sku = 'draft-' + randomUUID().slice(0, 8); const payload = productDraftSchema.parse({ name: 'Synthetic cosmetic', sku, shopProductId: sku, category: '369 BeautyLine', shortDescription: 'Synthetic fixture', description: { wirkung: 'Synthetic fixture', dosierung: '' }, mockupImageUrl: 'https://example.com/test.png', variants: [{ sku, dosage: '10 ml', price: 10 }], seo: { slug: sku, seoTitle: 'Synthetic cosmetic', seoDescription: 'Synthetic fixture description', canonical: 'https://www.369research.eu/product/' + sku }, merchant: { brand: '369 Research', googleProductCategory: '123', productType: 'Cosmetic', availability: 'out_of_stock' }, translations: [{ lang: 'de', name: 'Test', merchantTitle: 'Test', merchantDescription: 'Fixture' }, { lang: 'en', name: 'Test', merchantTitle: 'Test', merchantDescription: 'Fixture' }], faqs: [], useCases: [] }); try {
    assert.ok(Array.isArray((await draftOptions(pool)).useCases));
    const bad = await draftSave(pool, actor, { payload: { ...payload, mockupImageUrl: '' } });
    await assert.rejects(draftPreview(pool, actor, { id: bad.draft.id, revision: 1 }), /validation_incomplete/);
    const d = await draftSave(pool, {...actor,id:randomUUID(),role:'operator'}, { payload });
    assert.equal(d.validation.score, 100);
    const p = await draftPreview(pool, actor, { id: d.draft.id, revision: 1 });
    await assert.rejects(draftPublish(pool, { ...actor, role: 'operator' }, { previewId: p.previewId, confirmationSku: sku }), /role_denied/);
    const r = await draftPublish(pool, actor, { previewId: p.previewId, confirmationSku: sku });
    assert.equal(r.status, 'completed');
    assert.equal((r as any).result.variants[0].stock, 0);
    assert.equal((await draftPublish(pool, actor, { previewId: p.previewId, confirmationSku: sku })).status, 'completed');
    assert.equal(Number((await pool.query('SELECT count(*) FROM articles WHERE sku=$1', [sku])).rows[0].count), 1);
}
finally {
    await pool.end();
} });
