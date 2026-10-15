import {runPartnerAudit} from "./partnerAudit.js";
import {operationsDetail} from './operationsDetails.js';
import { simulateCheckout } from './operationsSimulation.js';
import { searchOperations } from './operationsSearch.js';
import { diagnosePartner } from './operationsPartner.js';
import { promotionCurrent, promotionPreview, promotionExecute } from './operationsPromotion.js';
import { draftSave, draftList, draftPreview, draftPublish, draftTemplate, draftOptions } from './operationsDraft.js';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getPool } from './db.js';
import { verifyOperationsActor } from './operationsAuth.js';
import { readOperationsInventory } from './operationsInventory.js';
import { previewStock, confirmStock, executeStock, stockStatus } from './operationsStock.js';
export const operationsRouter = Router();
operationsRouter.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const actor = verifyOperationsActor(req.get('authorization'), req.method, req.originalUrl, req.body);
    if (!actor) {
        res.status(401).json({ code: 'unauthorized' });
        return;
    }
    res.locals.opsActor = actor;
    next();
});
operationsRouter.use(rateLimit({ windowMs: 60000, limit: 90, keyGenerator: (_req, res) => res.locals.opsActor.id, standardHeaders: true, legacyHeaders: false }));
operationsRouter.post('/capabilities', (_req, res) => res.json({ inventory: true, history: true, stock: process.env.OPS_STOCK_ENABLED === 'true' && ['operator', 'admin'].includes(res.locals.opsActor.role), simulation: true, productPublish: process.env.OPS_PRODUCT_PUBLISH_ENABLED === 'true' && res.locals.opsActor.role === 'admin', promotion: process.env.OPS_PROMOTION_ENABLED === 'true' && res.locals.opsActor.role === 'admin' }));
operationsRouter.post('/simulate', async (req, res) => {
    try {
        res.json(await simulateCheckout(req.body, req, res));
    }
    catch (e) {
        res.status(e instanceof z.ZodError ? 400 : 409).json({ code: e instanceof z.ZodError ? 'invalid_input' : 'simulation_rejected', message: e instanceof Error ? e.message : 'Simulation nicht verfügbar' });
    }
});
operationsRouter.post('/partner-audit', async(req,res)=>{try{z.object({}).strict().parse(req.body);res.json(await runPartnerAudit(req,res));}catch{res.status(503).json({code:'partner_audit_unavailable'});}});
operationsRouter.post('/partner', async (req, res) => {
    try {
        res.json(await diagnosePartner(req.body));
    }
    catch {
        res.status(409).json({ code: 'partner_diagnosis_unavailable' });
    }
});
operationsRouter.post('/search', async (req, res) => {
    try {
        res.json(await searchOperations(req.body));
    }
    catch (e) {
        res.status(e instanceof z.ZodError ? 400 : 503).json({ code: 'search_unavailable' });
    }
});
for (const [action, handler] of [['current', promotionCurrent], ['preview', promotionPreview], ['execute', promotionExecute]] as const)
    operationsRouter.post('/promotion/' + action, async (req, res) => {
        try {
            const pool = await getPool();
            if (!pool)
                throw Error('unavailable');
            res.json(await (action === 'current' ? promotionCurrent(pool) : handler(pool, res.locals.opsActor, req.body)));
        }
        catch (e) {
            res.status(409).json({ code: e instanceof Error ? e.message : 'promotion_unavailable' });
        }
    });
for (const action of ['list', 'options', 'template', 'save', 'preview', 'publish'])
    operationsRouter.post('/draft/' + action, async (req, res) => {
        try {
            const pool = await getPool();
            if (!pool)
                throw Error('unavailable');
            const actor = res.locals.opsActor;
            res.json(await (action === 'options' ? draftOptions(pool) : action === 'list' ? draftList(pool, actor) : action === 'template' ? draftTemplate(pool, req.body) : action === 'save' ? draftSave(pool, actor, req.body) : action === 'preview' ? draftPreview(pool, actor, req.body) : draftPublish(pool, actor, req.body)));
        }
        catch (e) {
            res.status(409).json({ code: e instanceof z.ZodError ? 'invalid_input' : e instanceof Error ? e.message : 'draft_unavailable' });
        }
    });
operationsRouter.post('/details',async(req,res)=>{try{res.json(await operationsDetail(req.body,res.locals.opsActor));}catch(e){res.status(409).json({code:e instanceof Error?e.message:'detail_unavailable'});}});
operationsRouter.post('/runs', async (_req, res) => {
    try {
        const pool = await getPool();
        if (!pool)
            throw Error('unavailable');
        res.json({ runs: (await pool.query('SELECT r.id AS idempotency_key,r.state,r.created_at,r.completed_at,r.result,p.operation_type,p.target_sku FROM ops_console_receipts r JOIN ops_console_previews p ON p.id=r.preview_id WHERE r.actor_id=$1 ORDER BY r.created_at DESC LIMIT 50', [res.locals.opsActor.id])).rows });
    }
    catch {
        res.status(503).json({ code: 'runs_unavailable' });
    }
});
operationsRouter.post('/inventory', async (req, res) => {
    let client;
    try {
        z.object({}).strict().parse(req.body);
        const pool = await getPool();
        if (!pool)
            throw Error('unavailable');
        client = await pool.connect();
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout='8000ms'");
        const data = await readOperationsInventory(client);
        await client.query('COMMIT');
        res.json(data);
    }
    catch (e) {
        await client?.query('ROLLBACK').catch(() => { });
        res.status(e instanceof z.ZodError ? 400 : 503).json({ code: e instanceof z.ZodError ? 'invalid_input' : 'inventory_unavailable' });
    }
    finally {
        client?.release();
    }
});
operationsRouter.post('/history', async (req, res) => {
    let client;
    try {
        const input = z.object({ articleId: z.number().int().positive(), sku: z.string().min(1).max(50), beforeId: z.number().int().positive().optional() }).strict().parse(req.body);
        const pool = await getPool();
        if (!pool)
            throw Error('unavailable');
        client = await pool.connect();
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout='5000ms'");
        const target = (await client.query('SELECT id,sku,stock FROM articles WHERE id=$1 AND sku=$2', [input.articleId, input.sku])).rows[0];
        if (!target) {
            await client.query('ROLLBACK');
            res.status(404).json({ code: 'identity_mismatch' });
            return;
        }
        const history = (await client.query(`SELECT id,change_type AS type,quantity_before AS before,quantity_change AS change,quantity_after AS after,created_at AS at FROM stock_history WHERE article_id=$1 AND ($2::int IS NULL OR id<$2) ORDER BY id DESC LIMIT 51`, [input.articleId, input.beforeId ?? null])).rows;
        await client.query('COMMIT');
        res.json({ target, history: history.slice(0, 50), nextCursor: history.length > 50 ? history[49].id : null });
    }
    catch (e) {
        await client?.query('ROLLBACK').catch(() => { });
        res.status(e instanceof z.ZodError ? 400 : 503).json({ code: 'history_unavailable' });
    }
    finally {
        client?.release();
    }
});
for (const [path, handler] of [['preview', previewStock], ['confirm', confirmStock], ['execute', executeStock], ['status', stockStatus]] as const) {
    operationsRouter.post('/stock/' + path, async (req, res) => {
        try {
            const pool = await getPool();
            if (!pool)
                throw Error('unavailable');
            res.json(await handler(pool, res.locals.opsActor, req.body));
        }
        catch (e) {
            const message = e instanceof Error ? e.message : 'unavailable';
            const code = e instanceof z.ZodError ? 'invalid_input' : ['role_denied', 'stock_not_enabled', 'identity_mismatch', 'identity_ambiguous', 'preview_not_found', 'preview_stale', 'confirmation_required', 'confirmation_mismatch'].includes(message) ? message : 'operation_conflict';
            res.status(code === 'role_denied' ? 403 : 409).json({ code });
        }
    });
}
operationsRouter.use((_req, res) => res.status(404).json({ code: 'operation_not_enabled' }));
