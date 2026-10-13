import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, withReadOnlyDatabase } from './db.js';
import { partners } from '../drizzle/schema.js';
import { getPartnerProgram, calculateSelfOrderDiscountPercent, canRedeemShopCredit } from './partnerProgramService.js';
export async function diagnosePartner(body: unknown) {
    const { partnerId } = z.object({ partnerId: z.number().int().positive() }).strict().parse(body);
    return withReadOnlyDatabase(async () => {
        const db = await getDb();
        if (!db)
            throw Error('unavailable');
        const [p] = await db.select().from(partners).where(eq(partners.id, partnerId)).limit(1);
        if (!p)
            throw Error('partner_not_found');
        const program = await getPartnerProgram(p.id);
        return { partner: { id: p.id, name: p.name, partnerNumber: p.partnerNumber, active: p.isActive === 1 }, program, ownDiscount: program ? calculateSelfOrderDiscountPercent(program, Number(p.customerDiscountPercent), Number(p.commissionPercent)) : null, credit: { balance: Number(p.creditBalance), redeemable: p.isActive === 1 && !!program && canRedeemShopCredit(program) }, observedAt: new Date().toISOString() };
    });
}
