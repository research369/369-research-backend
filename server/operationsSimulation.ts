import { calculateAuthoritativeShipping, resolveShippingRegion } from './kwkCheckoutPricing.js';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { articles, partners } from '../drizzle/schema.js';
import { getDb, withReadOnlyDatabase } from './db.js';
import { getPublicShopVariants } from './articleRouter.js';
import { orderRouter } from './orderRouter.js';
import { extractDosageMg, isSubstitutionEnabled, resolveSubstitution } from './substitutionService.js';
import type { Request, Response } from 'express';
export const simulationSchema = z.object({ items: z.array(z.object({ articleId: z.number().int().positive(), sku: z.string().min(1).max(50), shopProductId: z.string().min(1).max(100), variantKey: z.string().max(100), quantity: z.number().int().min(1).max(100) }).strict()).min(1).max(30), country: z.string().min(2).max(100), discountCode: z.string().max(80).optional(), partnerCode: z.string().max(80).optional(), partnerId: z.number().int().positive().optional(), creditUsed: z.number().min(0).max(100000).default(0) }).strict();
export async function simulateCheckout(body: unknown, req: Request, res: Response) {
    const i = simulationSchema.parse(body);
    return withReadOnlyDatabase(async () => {
        const db = await getDb();
        if (!db)
            throw Error('unavailable');
        const inventory = await db.select().from(articles);
        const mutable = inventory.map(a => ({ ...a }));
        const substitutionEnabled = await isSubstitutionEnabled();
        const stockPlan: any[] = [];
        const items = i.items.map(line => {
            const family = inventory.filter(a => a.shopProductId === line.shopProductId && a.isActive === 1 && a.shopVisible === 1);
            if (family.length !== 1)
                throw Error('identity_ambiguous');
            const variants = getPublicShopVariants(family[0], inventory);
            const v = variants.filter(v => v.articleId === line.articleId && v.sku === line.sku && v.dosage === line.variantKey);
            if (v.length !== 1 || v[0].hidden)
                throw Error('identity_mismatch');
            const target = mutable.find(a => a.id === line.articleId && a.sku === line.sku && a.isActive === 1);
            if (!target)
                throw Error('identity_mismatch');
            if (target.stock >= line.quantity) {
                target.stock -= line.quantity;
                stockPlan.push({ requestedSku: line.sku, available: true, substitution: false, components: [{ articleId: target.id, sku: target.sku, quantity: line.quantity }] });
            }
            else {
                const dose = extractDosageMg(line.variantKey);
                const plan = substitutionEnabled && dose ? resolveSubstitution(line.shopProductId, dose, line.quantity, mutable) : null;
                if (plan?.possible) {
                    for (const c of plan.components)
                        mutable.find(a => a.id === c.articleId)!.stock -= c.quantity;
                    stockPlan.push({ requestedSku: line.sku, available: true, substitution: true, components: plan.components.map(c => ({ articleId: c.articleId, sku: c.sku, quantity: c.quantity })) });
                }
                else
                    stockPlan.push({ requestedSku: line.sku, available: false, substitution: false, components: [] });
            }
            return { name: family[0].name, dosage: line.variantKey, price: v[0].price, quantity: line.quantity, type: 'peptide', shopProductId: line.shopProductId };
        });
        const partner = i.partnerId ? (await db.select().from(partners).where(eq(partners.id, i.partnerId)).limit(1))[0] : null;
        if (i.partnerId && !partner)
            throw Error('partner_not_found');
        if (i.creditUsed > 0 && !partner)
            throw Error('partner_required');
        const customer = partner ? { firstName: partner.name, lastName: '', email: partner.email, phone: partner.phone || '', street: partner.street || '', houseNumber: partner.houseNumber || '', zip: partner.zip || '', city: partner.city || '', country: partner.country || i.country } : { firstName: '', lastName: '', email: null, phone: '', street: '', houseNumber: '', zip: '', city: '', country: i.country };
        const result = await orderRouter.createCaller({ req, res, user: null, operationsPreview: { partnerId: i.partnerId } }).create({ items, customer, subtotal: items.reduce((n, l) => n + l.price * l.quantity, 0), discount: 0, discountCode: i.discountCode || null, partnerCode: i.partnerCode || null, partnerNumber: partner?.partnerNumber || undefined, creditUsed: i.creditUsed, shipping: calculateAuthoritativeShipping({ country: customer.country, items }), shippingCountry: resolveShippingRegion(customer.country), total: 0, paymentMethod: 'SEPA', date: new Date().toISOString() });
        return { ...(result as any).operationsPreview, stockPlan, available: stockPlan.every(p => p.available), checkedAt: new Date().toISOString(), limitations: ['Adressprüfung und Kundenzuordnung sind kein Bestandteil dieser Preis- und Bestandsvorschau.', 'KWK-Guthaben und Neukundenberechtigung benötigen eine identifizierte Kundensitzung.'], sideEffects: false };
    });
}
