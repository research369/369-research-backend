import { readFileSync } from 'node:fs';
import { getPool } from './db.js';

/** Owner-authorized startup data change, deliberately not called by any read/router service. */
export async function applyDanielShortPartnerCodeMigration(): Promise<void> {
  const pool = await getPool();
  if (!pool) throw Error('short_code_database_unavailable');
  const sql = readFileSync(new URL('../drizzle/migrations/0038_daniel_short_partner_code.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='2000ms'");
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('369:partner-code-replacement:20261126'))");
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
