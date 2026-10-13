import { sql, or } from 'drizzle-orm';
import { orders } from '../drizzle/schema.js';
import { normalizeKwkPhone } from './kwkCheckoutPricing.js';
export async function assertKwkNewCustomer(db: any, customer: {
    email?: string | null;
    phone: string;
}) {
    const normalizedEmail = (customer.email || '').trim().toLowerCase();
    const normalizedPhone = normalizeKwkPhone(customer.phone);
    const previousOrderConditions = [];
    if (normalizedEmail) {
        previousOrderConditions.push(sql `LOWER(TRIM(${orders.email})) = ${normalizedEmail}`);
    }
    if (normalizedPhone) {
        previousOrderConditions.push(sql `
            CASE
              WHEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g') LIKE '0049%'
                THEN '49' || regexp_replace(SUBSTRING(regexp_replace(${orders.phone}, '[^0-9]', '', 'g') FROM 5), '^0+', '')
              WHEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g') LIKE '490%'
                THEN '49' || SUBSTRING(regexp_replace(${orders.phone}, '[^0-9]', '', 'g') FROM 4)
              WHEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g') LIKE '49%'
                THEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g')
              WHEN regexp_replace(${orders.phone}, '[^0-9]', '', 'g') LIKE '0%'
                THEN '49' || regexp_replace(regexp_replace(${orders.phone}, '[^0-9]', '', 'g'), '^0+', '')
              ELSE regexp_replace(${orders.phone}, '[^0-9]', '', 'g')
            END = ${normalizedPhone}
          `);
    }
    const previousOrders = previousOrderConditions.length > 0
        ? await db.select({ id: orders.id }).from(orders)
            .where(or(...previousOrderConditions))
            .limit(1)
        : [];
    if (previousOrders.length > 0) {
        throw new Error("KWK_NUR_NEUKUNDEN: Der 10%-Empfehlungsrabatt gilt ausschließlich für die erste Bestellung.");
    }
}
export async function assertKwkCreditAvailable(db: any, accountId: number, credit: number, lock = false) {
    const lockedAccount = await db.execute(sql `
          SELECT id FROM kwk_accounts
          WHERE id=${accountId} AND status='aktiv' AND deleted_at IS NULL
          ${lock ? sql `FOR UPDATE` : sql ``}
        `);
    if (lockedAccount.rows.length !== 1) {
        throw new Error("KWK_GUTHABEN_ACCOUNT_NICHT_AKTIV");
    }
    const balanceResult = await db.execute(sql `
          SELECT COALESCE(SUM(CASE
            WHEN type IN ('credit_released','redeemed','cancelled','refund','manual_correction')
             AND status='confirmed' THEN amount ELSE 0 END), 0) AS available
          FROM kwk_ledger WHERE kwk_id=${accountId}
        `);
    const available = Number(balanceResult.rows[0]?.available || 0);
    if (available + 0.001 < credit) {
        throw new Error(`KWK_GUTHABEN_NICHT_AUSREICHEND: Verfügbar ${available.toFixed(2)} €`);
    }
}
