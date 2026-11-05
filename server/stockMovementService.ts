import { eq, sql } from 'drizzle-orm';
import { articles, stockHistory } from '../drizzle/schema.js';
/** Caller supplies its transaction. History and stock always commit together. */
export async function applyStockMovement(db: any, input: {
    articleId: number;
    sku: string;
    expectedStock: number;
    change: number;
    type: 'wareneingang' | 'verkauf' | 'korrektur' | 'retoure';
    reason: string;
    actor: string;
    orderId?: string;
    expectedPrice?: number;
}) {
    if (!Number.isSafeInteger(input.change) || !Number.isSafeInteger(input.expectedStock))
        throw Error('invalid_stock');
    const [a] = await db.select().from(articles).where(eq(articles.id, input.articleId)).for('update');
    if (!a || a.sku !== input.sku || a.stock !== input.expectedStock)
        throw Error('stock_conflict');
    if (input.expectedPrice !== undefined && Number(Number(a.salePrice) > 0 ? a.salePrice : a.sellingPrice) !== input.expectedPrice)
        throw Error('stock_conflict');
    const after = a.stock + input.change;
    if (after < 0 || after > 2147483647)
        throw Error('invalid_stock');
    await db.update(articles).set({ stock: sql `${articles.stock}+${input.change}`, updatedAt: new Date() }).where(eq(articles.id, a.id));
    const [movement] = await db.insert(stockHistory).values({ articleId: a.id, quantityBefore: a.stock, quantityChange: input.change, quantityAfter: after, changeType: input.type, reason: input.reason, orderId: input.orderId ?? null, userName: input.actor }).returning();
    return { before: a.stock, after, movementId: movement.id };
}
