import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { OpsActor } from './operationsAuth.js';
import { orderHash } from './jarvyOrderContract.js';
import { validateProductData } from './productValidation.js';
const text = z.string().max(10000);
const url = z.union([z.literal(''), z.string().url().startsWith('https://').max(2000)]);
export const productDraftSchema = z.object({ articleId: z.number().int().positive().nullable().default(null), name: z.string().max(200), sku: z.string().max(50), shopProductId: z.string().max(100), category: z.string().max(100), categories: z.array(z.string().max(100)).max(20).default([]), shortDescription: text, description: z.record(z.unknown()), mockupImageUrl: url, labelImageUrl: url.default(''), casNumber: z.string().max(50).default(''), purity: z.string().max(20).default(''), variants: z.array(z.object({ articleId: z.number().int().positive().nullable().default(null), sku: z.string().min(1).max(50), dosage: z.string().min(1).max(100), price: z.number().min(0).max(99999999), salePrice: z.number().min(0).max(99999999).nullable().default(null) }).strict()).max(40), seo: z.object({ slug: z.string().max(200), seoTitle: z.string().max(70), seoDescription: z.string().max(160), canonical: z.string().max(2000) }).strict(), merchant: z.object({ brand: z.string().max(100), googleProductCategory: z.string().max(10), productType: z.string().max(200), availability: z.enum(['in_stock', 'out_of_stock', 'preorder']) }).strict(), translations: z.array(z.object({ lang: z.enum(['de', 'en']), name: z.string().max(200), merchantTitle: z.string().max(150), merchantDescription: text }).strict()).max(2), faqs: z.array(z.object({ lang: z.enum(['de', 'en']), question: z.string().max(2000), answer: text, isVisible: z.number().int().min(0).max(1).default(1) }).strict()).max(30), useCases: z.array(z.number().int().positive()).max(30) }).strict();
function edit(a: OpsActor) {
    if (!['operator', 'admin'].includes(a.role))
        throw Error('role_denied');
}
async function snapshot(c: PoolClient, p: z.infer<typeof productDraftSchema>) {
    const family = (await c.query('SELECT * FROM articles WHERE shop_product_id=$1 ORDER BY id FOR UPDATE', [p.shopProductId])).rows;
    if (p.articleId) {
        const main = family.find(a => a.id === p.articleId && a.sku === p.sku);
        if (!main || family.filter(a => a.shop_visible === 1 && a.is_active === 1).length !== 1 || main.shop_visible !== 1)
            throw Error('identity_mismatch');
        if (p.variants[0]?.articleId !== p.articleId)
            throw Error('variant_identity_mismatch');
        for (const v of p.variants) {
            if (!v.articleId || !family.some(a => a.id === v.articleId && a.sku === v.sku))
                throw Error('variant_identity_mismatch');
        }
    }
    else if (family.length)
        throw Error('product_already_exists');
    const ids = family.map(a => a.id);
    const auxiliaries: Record<string, any[]> = {};
    for (const table of ['article_seo', 'article_merchant', 'article_translations', 'article_faq', 'article_use_cases'])
        auxiliaries[table] = (await c.query(`SELECT * FROM ${table} WHERE article_id=ANY($1::int[]) ORDER BY id`, [ids])).rows;
    return { family, auxiliaries };
}
export function validateDraft(p: z.infer<typeof productDraftSchema>) {
    const v = p.variants[0];
    const base = validateProductData({ ...p, description: { product: p.description, faq: p.faqs.map(f => [f.question, f.answer]), translations: p.translations.map(t => [t.name, t.merchantTitle, t.merchantDescription]) }, sellingPrice: v?.price ?? 0, salePrice: v?.salePrice ?? null, stock: 0 }, p.seo, p.merchant, p.translations.find(t => t.lang === 'de'));
    const issues = [...base.issues], warnings = [...base.warnings];
    if (!p.variants.length)
        issues.push('Mindestens eine Variante erforderlich.');
    if (p.variants[0]?.sku !== p.sku)
        issues.push('Die erste Variante muss die SKU des Familienartikels besitzen.');
    if (new Set(p.variants.map(v => v.sku)).size !== p.variants.length || new Set(p.variants.map(v => v.dosage.trim().toLowerCase())).size !== p.variants.length)
        issues.push('SKU und Dosierungen müssen eindeutig sein.');
    for (const v of p.variants) {
        if (v.price <= 0 || v.salePrice !== null && v.salePrice >= v.price)
            issues.push('Ungültiger Preis für ' + v.sku);
        if (p.articleId && !v.articleId || !p.articleId && v.articleId)
            issues.push('Varianten-ID passt nicht zum Entwurfstyp.');
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.seo.slug))
        issues.push('Slug muss aus Kleinbuchstaben, Zahlen und Bindestrichen bestehen.');
    if (!p.translations.some(t => t.lang === 'en' && t.name && t.merchantTitle && t.merchantDescription))
        warnings.push('Englische Produkt- und Merchanttexte fehlen.');
    if (new Set(p.translations.map(t => t.lang)).size !== p.translations.length)
        issues.push('Sprache doppelt erfasst.');
    if (p.faqs.some(f => !f.question.trim() || !f.answer.trim()))
        issues.push('FAQ-Frage und Antwort dürfen nicht leer sein.');
    return { ...base, issues, warnings, score: issues.length || warnings.length ? Math.min(99, base.score) : 100, isValid: issues.length === 0 && warnings.length === 0 };
}
export async function draftSave(pool: Pool, a: OpsActor, body: unknown) {
    edit(a);
    const i = z.object({ id: z.string().uuid().optional(), revision: z.number().int().positive().optional(), payload: productDraftSchema }).strict().parse(body);
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        let record;
        if (i.id) {
            record = (await c.query("UPDATE ops_console_drafts SET payload=$3,revision=revision+1,updated_at=now(),status='draft' WHERE id=$1 AND (actor_id=$2 OR $5::bool) AND revision=$4 AND status<>'published' RETURNING *", [i.id, a.id, i.payload, i.revision, a.role === 'admin'])).rows[0];
            if (!record)
                throw Error('draft_conflict');
        }
        else
            record = (await c.query('INSERT INTO ops_console_drafts(id,actor_id,payload) VALUES($1,$2,$3) RETURNING *', [randomUUID(), a.id, i.payload])).rows[0];
        await c.query("INSERT INTO ops_console_events(actor_id,event_type,data) VALUES($1,'draft.saved',$2)", [a.id, { id: record.id, revision: record.revision }]);
        await c.query('COMMIT');
        return { draft: record, validation: validateDraft(i.payload) };
    }
    catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        throw e;
    }
    finally {
        c.release();
    }
}
export async function draftList(pool: Pool, a: OpsActor) { return { drafts: (await pool.query('SELECT id,revision,status,payload,updated_at FROM ops_console_drafts WHERE actor_id=$1 OR $2::bool ORDER BY updated_at DESC LIMIT 100', [a.id, a.role === 'admin'])).rows }; }
export async function draftPreview(pool: Pool, a: OpsActor, body: unknown) {
    edit(a);
    const { id, revision } = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict().parse(body);
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const d = (await c.query('SELECT * FROM ops_console_drafts WHERE id=$1 AND (actor_id=$2 OR $4::bool) AND revision=$3 FOR UPDATE', [id, a.id, revision, a.role === 'admin'])).rows[0];
        if (!d || d.status === 'published')
            throw Error('draft_conflict');
        const p = productDraftSchema.parse(d.payload), validation = validateDraft(p);
        if (!validation.isValid)
            throw Error('validation_incomplete');
        const before = await snapshot(c, p);
        const previewId = randomUUID(), key = randomUUID();
        await c.query("INSERT INTO ops_console_previews(id,actor_id,operation_type,target_id,target_sku,before_snapshot,planned_mutation,expected_hash,idempotency_key,expires_at) VALUES($1,$2,'product_publish',$3,$4,$5,$6,$7,$8,now()+interval '5 minutes')", [previewId, a.id, p.articleId ?? 0, p.sku, before, { draftId: id, revision, payload: p }, orderHash(before), key]);
        await c.query('COMMIT');
        return { previewId, idempotencyKey: key, sku: p.sku, validation, expiresAt: new Date(Date.now() + 300000).toISOString(), existing: !!p.articleId };
    }
    catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        throw e;
    }
    finally {
        c.release();
    }
}
export async function draftPublish(pool: Pool, a: OpsActor, body: unknown) {
    if (a.role !== 'admin')
        throw Error('role_denied');
    if (process.env.OPS_PRODUCT_PUBLISH_ENABLED !== 'true')
        throw Error('publication_not_enabled');
    const i = z.object({ previewId: z.string().uuid(), confirmationSku: z.string().min(1).max(50) }).strict().parse(body);
    const c = await pool.connect();
    let commitStarted = false, key = '';
    try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout='3000ms'");
        const r = (await c.query("SELECT *,expires_at>now() AS fresh FROM ops_console_previews WHERE id=$1 AND actor_id=$2 AND operation_type='product_publish' FOR UPDATE", [i.previewId, a.id])).rows[0];
        if (!r || r.target_sku !== i.confirmationSku)
            throw Error('confirmation_mismatch');
        key = r.idempotency_key;
        const old = (await c.query('SELECT state,result FROM ops_console_receipts WHERE id=$1', [key])).rows[0];
        if (old) {
            await c.query('COMMIT');
            return { idempotencyKey: key, status: old.state, result: old.result };
        }
        if (!r.fresh)
            throw Error('preview_stale');
        const planned = r.planned_mutation, p = productDraftSchema.parse(planned.payload);
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['ops-product:' + p.shopProductId]);
        const draft = (await c.query('SELECT * FROM ops_console_drafts WHERE id=$1 FOR UPDATE', [planned.draftId])).rows[0];
        if (!draft || draft.revision !== planned.revision || draft.status === 'published' || orderHash(draft.payload) !== orderHash(p))
            throw Error('draft_conflict');
        if (!validateDraft(p).isValid)
            throw Error('validation_incomplete');
        const before = await snapshot(c, p);
        if (orderHash(before) !== r.expected_hash)
            throw Error('preview_stale');
        const cases = (await c.query('SELECT id FROM use_cases WHERE id=ANY($1::int[])', [p.useCases])).rows;
        if (cases.length !== new Set(p.useCases).size)
            throw Error('use_case_missing');
        const collision = (await c.query('SELECT article_id FROM article_seo WHERE slug=$1 AND article_id<>$2', [p.seo.slug, p.articleId ?? 0])).rows;
        if (collision.length)
            throw Error('slug_conflict');
        if (p.articleId) {
            const oldSlug = before.auxiliaries.article_seo.find(s => s.article_id === p.articleId)?.slug;
            if (oldSlug && oldSlug !== p.seo.slug)
                throw Error('slug_change_requires_redirect');
        }
        await c.query("INSERT INTO ops_console_receipts(id,preview_id,actor_id,target_id,state) VALUES($1,$2,$3,$4,'executing')", [key, r.id, a.id, p.articleId ?? 0]);
        const { drizzle } = await import('drizzle-orm/node-postgres');
        const { eq } = await import('drizzle-orm');
        const { articles, articleSeo, articleMerchant, articleTranslations, articleFaq, articleUseCases } = await import('../drizzle/schema.js');
        const db = drizzle(c);
        let main = p.articleId;
        const variantRows = [];
        for (let n = 0; n < p.variants.length; n++) {
            const v = p.variants[n];
            const data = { name: n === 0 ? p.name : p.name + ' (' + v.dosage + ')', sku: v.sku, shopProductId: p.shopProductId, category: p.category, categories: p.categories, sellingPrice: String(v.price), salePrice: v.salePrice === null ? null : String(v.salePrice), isActive: 1, shopVisible: n === 0 ? 1 : 0 };
            let id = v.articleId;
            if (id)
                await db.update(articles).set({ ...data, updatedAt: new Date() }).where(eq(articles.id, id));
            else {
                id = (await db.insert(articles).values({ ...data, stock: 0 }).returning())[0].id;
            }
            if (n === 0)
                main = id;
            variantRows.push({ dosage: v.dosage, price: v.salePrice ?? v.price, inventoryArticleId: id, sku: v.sku });
        }
        if (!main)
            throw Error('missing_main');
        await db.update(articles).set({ name: p.name, shortDescription: p.shortDescription, description: p.description, mockupImageUrl: p.mockupImageUrl, labelImageUrl: p.labelImageUrl, casNumber: p.casNumber, purity: p.purity, variants: variantRows, updatedAt: new Date() }).where(eq(articles.id, main));
        const oldSeo = before.auxiliaries.article_seo.find(s => s.article_id === main), oldMerchant = before.auxiliaries.article_merchant.find(s => s.article_id === main);
        if (oldSeo)
            await db.update(articleSeo).set({ ...p.seo, updatedAt: new Date() }).where(eq(articleSeo.id, oldSeo.id));
        else
            await db.insert(articleSeo).values({ articleId: main, ...p.seo });
        if (oldMerchant)
            await db.update(articleMerchant).set({ ...p.merchant, updatedAt: new Date() }).where(eq(articleMerchant.id, oldMerchant.id));
        else
            await db.insert(articleMerchant).values({ articleId: main, ...p.merchant });
        for (const t of p.translations) {
            const existing = before.auxiliaries.article_translations.find(e => e.article_id === main && e.lang === t.lang);
            if (existing)
                await db.update(articleTranslations).set({ ...t, updatedAt: new Date() }).where(eq(articleTranslations.id, existing.id));
            else
                await db.insert(articleTranslations).values({ ...t, articleId: main });
        }
        for (const table of [articleFaq, articleUseCases])
            await db.delete(table).where(eq(table.articleId, main));
        if (p.faqs.length)
            await db.insert(articleFaq).values(p.faqs.map((f, n) => ({ ...f, articleId: main, sortOrder: n })));
        if (p.useCases.length)
            await db.insert(articleUseCases).values(p.useCases.map((id, n) => ({ articleId: main, useCaseId: id, sortOrder: n, isPrimary: before.auxiliaries.article_use_cases.find(e => e.article_id === main && e.use_case_id === id)?.is_primary ?? 0 })));
        const after = (await c.query('SELECT id,sku,stock,shop_visible,ops_version FROM articles WHERE shop_product_id=$1 ORDER BY id', [p.shopProductId])).rows;
        const result = { articleId: main, shopProductId: p.shopProductId, variants: after, score: 100 };
        await c.query("UPDATE ops_console_drafts SET status='published',updated_at=now() WHERE id=$1", [planned.draftId]);
        await c.query("UPDATE ops_console_previews SET status='completed',confirmed_at=now() WHERE id=$1", [r.id]);
        await c.query("UPDATE ops_console_receipts SET state='completed',result=$2,completed_at=now() WHERE id=$1", [key, result]);
        await c.query("INSERT INTO ops_console_events(receipt_id,actor_id,event_type,data) VALUES($1,$2,'product.published',$3)", [key, a.id, result]);
        commitStarted = true;
        await c.query('COMMIT');
        return { idempotencyKey: key, status: 'completed', result };
    }
    catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        if (commitStarted)
            return { status: 'outcome_unknown', idempotencyKey: key };
        throw e;
    }
    finally {
        c.release();
    }
}
export async function draftTemplate(pool: Pool, body: unknown) {
    const { articleId } = z.object({ articleId: z.number().int().positive() }).strict().parse(body);
    const c = await pool.connect();
    try {
        await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const a = (await c.query('SELECT * FROM articles WHERE id=$1 AND shop_visible=1', [articleId])).rows[0];
        if (!a)
            throw Error('identity_mismatch');
        const family = (await c.query('SELECT * FROM articles WHERE shop_product_id=$1 ORDER BY id', [a.shop_product_id])).rows;
        const seo = (await c.query('SELECT * FROM article_seo WHERE article_id=$1 LIMIT 1', [a.id])).rows[0];
        const merchant = (await c.query('SELECT * FROM article_merchant WHERE article_id=$1 LIMIT 1', [a.id])).rows[0];
        const translations = (await c.query('SELECT * FROM article_translations WHERE article_id=$1 ORDER BY id', [a.id])).rows;
        const faqs = (await c.query('SELECT * FROM article_faq WHERE article_id=$1 ORDER BY sort_order,id', [a.id])).rows;
        const cases = (await c.query('SELECT use_case_id FROM article_use_cases WHERE article_id=$1 ORDER BY sort_order,id', [a.id])).rows;
        const variants = Array.isArray(a.variants) && a.variants.length ? a.variants.map((v: any) => { const row = family.find(r => r.id === Number(v.inventoryArticleId)); return { articleId: row?.id ?? null, sku: row?.sku ?? v.sku ?? '', dosage: String(v.dosage ?? v.label ?? v.name ?? ''), price: Number(row?.selling_price ?? v.price ?? 0), salePrice: row?.sale_price === null ? null : row?.sale_price ? Number(row.sale_price) : null }; }) : [{ articleId: a.id, sku: a.sku, dosage: a.name.match(/\d+(?:\.\d+)?\s*(?:mg|ml|iu)\b/i)?.[0] ?? 'Standard', price: Number(a.selling_price), salePrice: a.sale_price === null ? null : Number(a.sale_price) }];
        variants.sort((x: any, y: any) => Number(y.articleId === a.id) - Number(x.articleId === a.id));
        const payload = { articleId: a.id, name: a.name, sku: a.sku, shopProductId: a.shop_product_id ?? '', category: a.category ?? '', categories: Array.isArray(a.categories) ? a.categories : [], shortDescription: a.short_description ?? '', description: typeof a.description === 'object' && a.description ? a.description : { wirkung: typeof a.description === 'string' ? a.description : '' }, mockupImageUrl: a.mockup_image_url ?? '', labelImageUrl: a.label_image_url ?? '', casNumber: a.cas_number ?? '', purity: a.purity ?? '', variants, seo: { slug: seo?.slug ?? '', seoTitle: seo?.seo_title ?? '', seoDescription: seo?.seo_description ?? '', canonical: seo?.canonical ?? '' }, merchant: { brand: merchant?.brand ?? '369 Research', googleProductCategory: merchant?.google_product_category ?? '', productType: merchant?.product_type ?? '', availability: merchant?.availability ?? 'in_stock' }, translations: translations.filter(t => ['de', 'en'].includes(t.lang)).map(t => ({ lang: t.lang, name: t.name ?? a.name, merchantTitle: t.merchant_title ?? '', merchantDescription: t.merchant_description ?? '' })), faqs: faqs.filter(f => ['de', 'en'].includes(f.lang)).map(f => ({ lang: f.lang, question: f.question, answer: f.answer, isVisible: f.is_visible ?? 1 })), useCases: cases.map(c => c.use_case_id) };
        await c.query('COMMIT');
        return { payload, validation: validateDraft(productDraftSchema.parse(payload)) };
    }
    catch (e) {
        await c.query('ROLLBACK').catch(() => { });
        throw e;
    }
    finally {
        c.release();
    }
}
export async function draftOptions(pool: Pool) { return { useCases: (await pool.query("SELECT DISTINCT ON (u.id) u.id,coalesce(to_jsonb(t)->>'name',to_jsonb(t)->>'title',u.slug) AS name FROM use_cases u LEFT JOIN use_case_translations t ON t.use_case_id=u.id AND t.lang='de' ORDER BY u.id,t.id LIMIT 1000")).rows }; }
