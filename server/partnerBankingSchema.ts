import { readFile } from 'node:fs/promises';
import { getPool } from './db.js';
let readiness: Promise<void> | undefined;
/** Called ONLY by partnerBanking operations; importing/mounting does no IO.
 * Read SQL inside the promise so missing files/DB/DDL failures remain retryable.
 */
export async function ensurePartnerBankingSchema(): Promise<void> {
  if (!readiness) {
    readiness = (async () => {
      const sql = await readFile(new URL('../drizzle/migrations/0036_partner_bank_accounts.sql', import.meta.url), 'utf8');
      const pool = await getPool();
      if (!pool) throw Error('BANK_DATABASE_UNAVAILABLE');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('369:partner-banking-schema:v1'))");
        await client.query(sql);
        await client.query('COMMIT');
      } catch { await client.query('ROLLBACK').catch(() => {}); throw Error('BANK_DATABASE_UNAVAILABLE'); }
      finally { client.release(); }
    })().catch(() => { readiness = undefined; throw Error('BANK_DATABASE_UNAVAILABLE'); });
  }
  await readiness;
}
