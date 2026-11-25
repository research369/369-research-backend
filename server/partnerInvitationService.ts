import bcrypt from 'bcryptjs';
import type { Pool, PoolClient } from 'pg';
import { TRPCError } from '@trpc/server';
import { getPool } from './db.js';
import { ensurePartnerInvitationSchema } from './partnerInvitationSchema.js';
import { invitationKeyHash, newInvitationIdentifiers, type InvitationStatus, type PartnerInvitationSubmit } from './partnerInvitationContract.js';
import { enqueuePartnerInvitationMail, startPartnerInvitationMailDispatch } from './partnerInvitationMailService.js';

async function database(): Promise<Pool> {
  await ensurePartnerInvitationSchema();
  const pool = await getPool();
  if (!pool) throw Error('Invitation database unavailable');
  return pool;
}
async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='8s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function safeStatus(client: Pick<Pool, 'query'>, row: any): Promise<InvitationStatus> {
  if (row.status !== 'approved') return { status: row.status === 'rejected' ? 'rejected' : 'pending' };
  const partner = await client.query('SELECT partner_number, code FROM partners WHERE id=$1', [row.linked_partner_id]);
  if (!partner.rows[0]) throw Error('Invitation link unavailable');
  return { status: 'approved', partnerNumber: partner.rows[0].partner_number, code: partner.rows[0].code };
}
/** Acknowledgement deliberately does not reveal existing emails or different recovery keys. */
export async function submitPartnerInvitation(input: PartnerInvitationSubmit): Promise<InvitationStatus> {
  const pool = await database();
  const keyHash = invitationKeyHash(input.registrationKey);
  // Equal work for new submissions and duplicates; never persist or return plaintext.
  const passwordHash = await bcrypt.hash(input.password, 12);
  let mailEventId: number | null = null;
  const transactionResult: InvitationStatus = await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`369:partner-invitation:email:${input.email}`]);
    const owned = await client.query('SELECT email, status, linked_partner_id FROM partner_invitation_applications WHERE registration_key_hash=$1', [keyHash]);
    if (owned.rows[0]) {
      return owned.rows[0].email === input.email ? safeStatus(client, owned.rows[0]) : { status: 'pending' };
    }
    const existing = await client.query('SELECT 1 FROM partners WHERE LOWER(BTRIM(email))=$1 LIMIT 1', [input.email]);
    if (existing.rows.length) return { status: 'pending' };
    // Unique email + hashed key prevent racing duplicates. Conflicts do not replace data.
    const inserted = await client.query(`INSERT INTO partner_invitation_applications
      (registration_key_hash, email, name, phone, company, password_hash, terms_version)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id, name, email`,
      [keyHash, input.email, input.name, input.phone, input.company || null, passwordHash, input.termsVersion]);
    if (inserted.rows[0]) {
      mailEventId = await enqueuePartnerInvitationMail(client, { id: Number(inserted.rows[0].id), name: inserted.rows[0].name, email: inserted.rows[0].email }, 'registration_acknowledgement');
    }
    return { status: 'pending' };
  });
  if (mailEventId !== null) startPartnerInvitationMailDispatch(mailEventId);
  return transactionResult;
}
/** POST only: high-entropy capability lookup, never an email lookup or query-string secret. */
export async function partnerInvitationStatus(registrationKey: string): Promise<InvitationStatus> {
  const pool = await database();
  const result = await pool.query('SELECT status, linked_partner_id FROM partner_invitation_applications WHERE registration_key_hash=$1', [invitationKeyHash(registrationKey)]);
  return result.rows[0] ? safeStatus(pool, result.rows[0]) : { status: 'pending' };
}
export async function pendingPartnerInvitations() {
  const pool = await database();
  const result = await pool.query(`SELECT id, name, email, phone, company, created_at AS "createdAt"
    FROM partner_invitation_applications WHERE status='pending' ORDER BY created_at, id LIMIT 100`);
  return result.rows as { id: number; name: string; email: string; phone: string; company: string | null; createdAt: Date }[];
}
export async function invitationIdentifiersAvailable(client: Pick<PoolClient, 'query'>, candidate: { code: string; partnerNumber: string }): Promise<boolean> {
  const collision = await client.query(`SELECT
    EXISTS(SELECT 1 FROM partner_codes WHERE UPPER(code_normalized)=$1 OR UPPER(display_code)=$1)
    OR EXISTS(SELECT 1 FROM partners WHERE UPPER(partner_number)=$2)
    OR EXISTS(SELECT 1 FROM partners p CROSS JOIN LATERAL regexp_split_to_table(COALESCE(p.code,''), ',') c(code) WHERE UPPER(BTRIM(c.code))=$1)
    OR EXISTS(SELECT 1 FROM promo_codes WHERE is_active=1 AND UPPER(BTRIM(code))=$1) AS occupied`, [candidate.code, candidate.partnerNumber]);
  return !collision.rows[0].occupied;
}
export type InvitationApproval = { status: 'approved'; id: number; partnerId: number; partnerNumber: string; code: string };
export async function approvePartnerInvitation(id: number, actor: string): Promise<InvitationApproval> {
  const pool = await database();
  let mailEventId: number | null = null;
  const transactionResult: InvitationApproval = await transaction(pool, async client => {
    const result = await client.query('SELECT * FROM partner_invitation_applications WHERE id=$1 FOR UPDATE', [id]);
    const app = result.rows[0];
    if (!app) throw new TRPCError({ code: 'NOT_FOUND', message: 'Antrag nicht gefunden.' });
    if (app.status === 'approved') {
      const status = await safeStatus(client, app);
      if (status.status !== 'approved') throw Error('Invitation approval unavailable');
      return { ...status, id, partnerId: app.linked_partner_id };
    }
    if (app.status !== 'pending') throw new TRPCError({ code: 'CONFLICT', message: 'Nur offene Anträge können freigegeben werden.' });
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`369:partner-invitation:email:${app.email}`]);
    // Existing admin account/code writers do not share our advisory locks. Short table
    // locks close the preflight/write race without adding global constraints or changing writers.
    await client.query('LOCK TABLE partners, partner_codes, promo_codes IN SHARE ROW EXCLUSIVE MODE');
    const existing = await client.query('SELECT 1 FROM partners WHERE LOWER(BTRIM(email))=$1 LIMIT 1', [app.email]);
    if (existing.rows.length) throw new TRPCError({ code: 'CONFLICT', message: 'Für diese E-Mail besteht bereits ein Partner. Keine Verknüpfung oder Änderung vorgenommen.' });
    const program = await client.query("SELECT * FROM partner_programs WHERE key='creator' FOR SHARE");
    const p = program.rows[0];
    if (!p || p.active !== true || p.settlement_method !== 'payout' || p.customer_discount_policy !== 'each_valid_code_use'
      || p.commission_policy !== 'each_paid_code_order' || p.allow_self_order_credit !== false) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Das bestehende Creator-Auszahlungsprogramm ist nicht bereit. Keine Konfiguration geändert.' });
    }
    let identifiers: { code: string; partnerNumber: string } | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const candidate = newInvitationIdentifiers(app.name);
      if (await invitationIdentifiersAvailable(client, candidate)) { identifiers = candidate; break; }
    }
    if (!identifiers) throw Error('Invitation identifiers unavailable');
    // Existing partners.phone is varchar(50). Preserve a 51-60 character submitted
    // phone in the application and the new partner's notes; never silently truncate it.
    const notes = `Personally invited by CEO Ben; accepted terms ${app.terms_version} at ${new Date(app.terms_accepted_at).toISOString()}`
      + (app.phone.length > 50 ? `; invitation phone: ${app.phone}` : '');
    const created = await client.query(`INSERT INTO partners
      (name,email,phone,company,code,partner_number,program_key,commission_type,commission_percent,
       customer_discount_percent,credit_balance,is_active,password_hash,notes)
      VALUES($1,$2,$3,$4,$5,$6,'creator','einmalig',10,10,0,1,$7,$8) RETURNING id`,
      [app.name, app.email, app.phone.length <= 50 ? app.phone : null, app.company, identifiers.code, identifiers.partnerNumber, app.password_hash, notes]);
    const partnerId = Number(created.rows[0].id);
    await client.query(`INSERT INTO partner_codes(partner_id,display_code,code_normalized,is_active,commission_percent,customer_discount_percent)
      VALUES($1,$2,$2,TRUE,10,10)`, [partnerId, identifiers.code]);
    await client.query(`UPDATE partner_invitation_applications SET status='approved', linked_partner_id=$2,
      reviewed_by=$3, reviewed_at=NOW(), updated_at=NOW() WHERE id=$1`, [id, partnerId, actor.slice(0, 100)]);
    mailEventId = await enqueuePartnerInvitationMail(client, { id, name: app.name, email: app.email }, 'approval', identifiers);
    return { status: 'approved', id, partnerId, partnerNumber: identifiers.partnerNumber, code: identifiers.code };
  });
  if (mailEventId !== null) startPartnerInvitationMailDispatch(mailEventId);
  return transactionResult;
}
export async function rejectPartnerInvitation(id: number, actor: string): Promise<{ id: number; status: 'rejected' }> {
  const pool = await database();
  return transaction(pool, async client => {
    const result = await client.query('SELECT status FROM partner_invitation_applications WHERE id=$1 FOR UPDATE', [id]);
    const row = result.rows[0];
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Antrag nicht gefunden.' });
    if (row.status === 'approved') throw new TRPCError({ code: 'CONFLICT', message: 'Ein bereits freigegebener Antrag kann nicht abgelehnt werden.' });
    if (row.status === 'pending') await client.query(`UPDATE partner_invitation_applications SET status='rejected',
      reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW() WHERE id=$1`, [id, actor.slice(0, 100)]);
    return { id, status: 'rejected' };
  });
}
