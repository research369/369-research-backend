import { TRPCError } from '@trpc/server';
import bcrypt from 'bcryptjs';
import type { Request } from 'express';
import { getPool } from './db.js';
import { enforceAuthRateLimit } from './accountSecurityService.js';
import { ensurePartnerBankingSchema } from './partnerBankingSchema.js';
import { assertPartnerBankKey, decryptPartnerBankAccount, encryptPartnerBankAccount } from './partnerBankingCrypto.js';
import { bankAccountFromInput, sameBankAccount, type PartnerBankSaveInput, type PartnerBankSnapshot } from './partnerBankingContract.js';
import type { Partner } from '../drizzle/schema.js';

const unavailable = () => new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Bankdaten vorübergehend nicht verfügbar. Bitte später erneut versuchen.' });
const unauthorized = () => new TRPCError({ code: 'UNAUTHORIZED', message: 'Partner-Login erforderlich. Bitte erneut anmelden.' });
const conflict = () => new TRPCError({ code: 'CONFLICT', message: 'Bankdaten wurden zwischenzeitlich geändert. Bitte neu laden und prüfen.' });
/** No raw DB/crypto/bcrypt error message/cause is propagated or logged. */
export async function bankingOperation<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { if (error instanceof TRPCError) throw error; throw unavailable(); }
}
async function bankDatabase() {
  assertPartnerBankKey();
  await ensurePartnerBankingSchema();
  const pool = await getPool();
  if (!pool) throw unavailable();
  return pool;
}
/** Public deployment probe: key + namespace DDL readiness only. No SELECT of
 * partners/bank accounts and no profile, balance, payout or credential writes.
 */
export async function partnerBankingReady(): Promise<{ ready: true }> {
  await bankDatabase();
  return { ready: true };
}
function snapshot(row: { version: number | null; encrypted_payload: string | null; updated_at: Date | null }, partnerId: number): PartnerBankSnapshot {
  if (row.version === null) return { version: 0, updatedAt: null, bankAccount: null };
  if (!Number.isInteger(row.version) || row.version < 1 || !row.encrypted_payload || !row.updated_at) throw unavailable();
  return { version: row.version, updatedAt: row.updated_at.toISOString(), bankAccount: decryptPartnerBankAccount(row.encrypted_payload, partnerId, row.version) };
}
export async function readOwnPartnerBankAccount(partner: Partner): Promise<PartnerBankSnapshot> {
  const pool = await bankDatabase();
  // Recheck revocation/activity in the same DB statement that reads the bank row.
  const result = await pool.query(`SELECT b.version, b.encrypted_payload, b.updated_at FROM partners p
    LEFT JOIN partner_bank_accounts b ON b.partner_id = p.id
    WHERE p.id = $1 AND p.is_active = 1 AND p.session_version = $2`, [partner.id, partner.sessionVersion]);
  if (!result.rows[0]) throw unauthorized();
  return snapshot(result.rows[0], partner.id);
}
export async function readAdminPartnerBankAccount(partnerId: number): Promise<PartnerBankSnapshot> {
  const pool = await bankDatabase();
  const result = await pool.query(`SELECT b.version, b.encrypted_payload, b.updated_at FROM partners p
    LEFT JOIN partner_bank_accounts b ON b.partner_id = p.id WHERE p.id = $1`, [partnerId]);
  if (!result.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Partner nicht gefunden.' });
  return snapshot(result.rows[0], partnerId);
}
export async function saveOwnPartnerBankAccount(req: Request, partner: Partner, input: PartnerBankSaveInput): Promise<PartnerBankSnapshot> {
  const pool = await bankDatabase();
  // Separate action buckets, DB-backed IP AND immutable authenticated identity.
  // Outside the business transaction: failed passwords/rollbacks retain attempts.
  await enforceAuthRateLimit(req, 'partner.banking.save', String(partner.id), pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Password-service lock order matches existing account-security writes. This
    // additive advisory lock does not change their logic or elevate any role.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`369:password:partner:${partner.id}`]);
    // Parent lock serializes two initial INSERTs even before a bank row exists.
    const locked = (await client.query('SELECT is_active, password_hash, session_version FROM partners WHERE id = $1 FOR UPDATE', [partner.id])).rows[0];
    if (!locked || locked.is_active !== 1 || Number(locked.session_version) !== partner.sessionVersion
      || !locked.password_hash || locked.password_hash !== partner.passwordHash) throw unauthorized();
    if (!await bcrypt.compare(input.currentPassword, locked.password_hash)) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Aktuelles Passwort konnte nicht bestätigt werden.' });
    }
    const row = (await client.query('SELECT version, encrypted_payload, updated_at FROM partner_bank_accounts WHERE partner_id = $1 FOR UPDATE', [partner.id])).rows[0];
    const current = row ? snapshot(row, partner.id) : { version: 0, updatedAt: null, bankAccount: null };
    const account = bankAccountFromInput(input);
    const identical = current.bankAccount !== null && sameBankAccount(current.bankAccount, account);
    // Only equal content at the current version OR a demonstrable immediately
    // preceding successful retry is idempotent. Arbitrary stale/future versions
    // remain CONFLICT even when content happens to be equal.
    if (input.version !== current.version && !(identical && input.version === current.version - 1)) throw conflict();
    if (identical) { await client.query('COMMIT'); return current; }
    if (current.version >= 2147483647) throw conflict();
    const version = current.version + 1;
    const encrypted = encryptPartnerBankAccount(account, partner.id, version);
    const saved = row
      ? await client.query(`UPDATE partner_bank_accounts SET version = $2, encrypted_payload = $3, updated_at = NOW()
          WHERE partner_id = $1 AND version = $4 RETURNING version, encrypted_payload, updated_at`, [partner.id, version, encrypted, current.version])
      : await client.query(`INSERT INTO partner_bank_accounts (partner_id, version, encrypted_payload)
          VALUES ($1, $2, $3) RETURNING version, encrypted_payload, updated_at`, [partner.id, version, encrypted]);
    if (!saved.rows[0]) throw conflict();
    await client.query(`INSERT INTO partner_bank_account_events (actor_partner_id, version, event)
      VALUES ($1, $2, 'bank_account_saved')`, [partner.id, version]);
    const result = snapshot(saved.rows[0], partner.id);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
