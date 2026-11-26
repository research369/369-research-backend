import assert from 'node:assert/strict';
import test, { before, after, beforeEach, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { ENV } from './env.js';
import { getPool, closeDb } from './db.js';
import { applyDanielShortPartnerCodeMigration } from './partnerCodeReplacementMigration.js';

const socket = process.env.PARTNER_INVITATION_TEST_PG_SOCKET;
if (!socket?.startsWith('/tmp/369-partner-invitation.') || !socket.endsWith('/socket')
  || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL || process.env.DOTENV_CONFIG_PATH !== '/dev/null'
  || process.env.PARTNER_INVITATION_TEST_SANITIZED !== '1') throw Error('DEDICATED_UNIX_FIXTURE_REQUIRED');
let pool: any, externalCalls = 0;
const oldCode = 'BEN-DANIELKREISMANN10-62E3CE90B458';
before(async () => {
  const fail = () => { externalCalls++; throw Error('NONFIXTURE_NETWORK_FORBIDDEN'); };
  mock.method(globalThis, 'fetch', fail as any);
  mock.method(http, 'request', fail as any); mock.method(http, 'get', fail as any);
  mock.method(https, 'request', fail as any); mock.method(https, 'get', fail as any);
  const connect = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const first = args[0]; const options = Array.isArray(first) ? first[0] : first;
    const path = typeof options === 'string' ? options : options?.path;
    if (path !== `${socket}/.s.PGSQL.55465`) return fail();
    return (connect as any).apply(this, args);
  });
  await closeDb();
  ENV.databaseUrl = `postgresql://invitation_local@localhost:55465/postgres?host=${encodeURIComponent(socket!)}`;
  ENV.resendApiKey = ''; pool = await getPool();
  // Create receipt schema in a database with no matching partner (safe no-op).
  await pool.query('TRUNCATE partner_codes,partners RESTART IDENTITY CASCADE');
  await applyDanielShortPartnerCodeMigration();
});
beforeEach(async () => {
  await pool.query(`TRUNCATE partner_code_replacement_receipts,partner_codes,partners,promo_codes,partner_programs RESTART IDENTITY CASCADE;
    INSERT INTO partner_programs(key,label,customer_discount_policy,commission_policy,settlement_method,allow_self_order_credit,active)
      VALUES('creator','Creator','each_valid_code_use','each_paid_code_order','payout',false,true);
    INSERT INTO partners(id,name,email,code,partner_number,program_key,commission_type,commission_percent,customer_discount_percent,credit_balance,is_active,password_hash,notes)
      VALUES(11,'Daniel Kreismann','daniel@fixture.invalid','${oldCode}','BEN-CEC6251E866C4B89','creator','einmalig',10,10,7.89,1,'UNCHANGED_HASH','UNCHANGED_NOTES'),
            (9001,'Untouched','other@fixture.invalid','OTHER10','OTHER-9001','creator','einmalig',5,3,12.34,1,'OTHER_HASH','OTHER_NOTES');
    INSERT INTO partner_codes(id,partner_id,display_code,code_normalized,is_active,commission_percent,customer_discount_percent)
      VALUES(1483,11,'${oldCode}','${oldCode}',true,10,10),(9001,9001,'OTHER10','OTHER10',true,5,3);
    SELECT setval(pg_get_serial_sequence('partner_codes','id'),9001,true);`);
});
after(async () => { assert.equal(externalCalls, 0); await closeDb(); ENV.databaseUrl = ''; mock.restoreAll(); });
const rows = async (table: string) => (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;

test('replaces only active public code, preserves identity, money, historical code and unrelated partner; replay idempotent', async () => {
  const beforePartners = await rows('partners'); const otherCode = (await rows('partner_codes'))[1];
  await applyDanielShortPartnerCodeMigration();
  const afterPartners = await rows('partners');
  const { code: _bc, updated_at: _bu, ...before } = beforePartners[0];
  const { code: _ac, updated_at: _au, ...after } = afterPartners[0];
  assert.deepEqual(after, before); assert.equal(afterPartners[0].code, 'DANIEL10');
  assert.deepEqual(afterPartners[1], beforePartners[1]);
  const codes = await rows('partner_codes');
  assert.equal(codes[0].id, 1483); assert.equal(codes[0].display_code, oldCode); assert.equal(codes[0].is_active, false);
  assert.deepEqual(codes.find((r: any) => r.id === 9001), otherCode);
  const fresh = codes.find((r: any) => r.display_code === 'DANIEL10');
  assert.equal(fresh.partner_id, 11); assert.equal(fresh.is_active, true);
  assert.equal(Number(fresh.commission_percent), 10); assert.equal(Number(fresh.customer_discount_percent), 10);
  assert.equal((await pool.query('SELECT * FROM partner_code_replacement_receipts')).rows.length, 1);
  const snapshot = { partners: await rows('partners'), codes: await rows('partner_codes') };
  await applyDanielShortPartnerCodeMigration();
  assert.deepEqual({ partners: await rows('partners'), codes: await rows('partner_codes') }, snapshot);
});

test('active promo collision rolls back every account/code change', async () => {
  await pool.query("INSERT INTO promo_codes(code,percentage,is_active) VALUES(' daniel10 ',20,1)");
  const before = { partners: await rows('partners'), codes: await rows('partner_codes') };
  await assert.rejects(applyDanielShortPartnerCodeMigration, /short_code_new_code_occupied/);
  assert.deepEqual({ partners: await rows('partners'), codes: await rows('partner_codes') }, before);
  assert.equal((await pool.query('SELECT * FROM partner_code_replacement_receipts')).rows.length, 0);
});

test('retired partner-code collision also rolls back, never reassigns a historical code', async () => {
  await pool.query("INSERT INTO partner_codes(partner_id,display_code,code_normalized,is_active,commission_percent,customer_discount_percent) VALUES(9001,'DANIEL10','DANIEL10',false,1,1)");
  const before = { partners: await rows('partners'), codes: await rows('partner_codes') };
  await assert.rejects(applyDanielShortPartnerCodeMigration, /short_code_new_code_occupied/);
  assert.deepEqual({ partners: await rows('partners'), codes: await rows('partner_codes') }, before);
});

test('changed financial terms fail closed and preserve all original data', async () => {
  await pool.query('UPDATE partners SET commission_percent=15 WHERE id=11');
  const before = { partners: await rows('partners'), codes: await rows('partner_codes') };
  await assert.rejects(applyDanielShortPartnerCodeMigration, /short_code_identity_or_terms_mismatch/);
  assert.deepEqual({ partners: await rows('partners'), codes: await rows('partner_codes') }, before);
});

test('fresh/unrelated database is a no-op; later intentional code edits are never overwritten', async () => {
  await pool.query("UPDATE partners SET code='CHANGED10' WHERE id=11");
  const before = { partners: await rows('partners'), codes: await rows('partner_codes') };
  await applyDanielShortPartnerCodeMigration();
  assert.deepEqual({ partners: await rows('partners'), codes: await rows('partner_codes') }, before);
});

test('migration has no email, password, ledger, orders or rights effects and is not called from read routes', () => {
  const sql = readFileSync(new URL('../drizzle/migrations/0038_daniel_short_partner_code.sql', import.meta.url), 'utf8');
  assert(!/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:orders|partner_transactions|partner_invitation_mail_events|users|operations_account_capability_grants)\b/i.test(sql));
  for (const file of ['partnerRouter.ts','partnerInvitationRouter.ts','partnerInvitationService.ts']) {
    assert(!readFileSync(new URL(file, import.meta.url), 'utf8').includes('applyDanielShortPartnerCodeMigration'));
  }
});
