import assert from 'node:assert/strict';
import test, { before, after, beforeEach, afterEach, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { ENV } from './env.js';
import { getPool, closeDb, withReadOnlyDatabase } from './db.js';
import { router } from './trpc.js';
import { partnerInvitationRouter } from './partnerInvitationRouter.js';
import { ensurePartnerInvitationSchema } from './partnerInvitationSchema.js';
import { ensurePermissionsSchema, isPermissionsSchemaReady } from './permissionsSchema.js';
import { ensureAdminChangeLogSchema } from './adminChangeLogService.js';
import { invitationKeyHash } from './partnerInvitationContract.js';
import { setPartnerInvitationMailTransportForTests, waitForPartnerInvitationMailDispatchesForTests } from './partnerInvitationMailService.js';

const socket = process.env.PARTNER_INVITATION_READ_TEST_PG_SOCKET;
if (!socket?.startsWith('/tmp/369-partner-invitation-read.') || !socket.endsWith('/socket') ||
    process.env.DATABASE_URL || process.env.RAILWAY_DB_URL || process.env.DOTENV_CONFIG_PATH !== '/dev/null' ||
    process.env.PARTNER_INVITATION_READ_TEST_SANITIZED !== '1') throw Error('DEDICATED_UNIX_READ_FIXTURE_REQUIRED');
const pm = { id: 2, username: 'product_manager', role: 'product_manager', name: null, email: null };
const admin = { ...pm, id: 1, username: 'synthetic_admin', role: 'admin' };
let pool: any, externalCalls = 0, mailCalls = 0, cookies = 0, startupDenied = 0;
let beforeState: Record<string, unknown>, businessTables: string[];
const app = router({ partnerInvitation: partnerInvitationRouter });
const caller = (user: any = pm) => app.createCaller({
  req: { headers: {}, ip: 'synthetic-local', socket: { remoteAddress: 'synthetic-local' } },
  res: { cookie() { cookies++; } }, user,
} as any);
const denied = (e: any) => ['UNAUTHORIZED', 'FORBIDDEN'].includes(e.code);
const pendingKeys = ['id', 'name', 'email', 'phone', 'company', 'createdAt'].sort();
const dayKeys = [...pendingKeys, 'status', 'reviewedAt', 'partnerId'].sort();
async function snapshot() {
  const state: Record<string, unknown> = {};
  for (const table of businessTables) {
    state[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return state;
}
async function seed(id: number, createdAt: string, status = 'pending') {
  await pool.query(`INSERT INTO partner_invitation_applications
    (id,registration_key_hash,email,name,phone,company,password_hash,terms_version,status,created_at,
     reviewed_at,reviewed_by,linked_partner_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'ben-10-10-v1',$8,$9,$10,$11,$12)`,
    [id, invitationKeyHash(randomUUID()), `app-${id}@fixture.invalid`, `Synthetic ${id}`, '+49000000',
      id === 11 ? null : 'Fixture GmbH', `NEVER_RETURN_PASSWORD_HASH_${id}`, status, createdAt,
      status === 'pending' ? null : '2026-11-26T12:00:00Z', status === 'pending' ? null : 'NEVER_RETURN_REVIEWER',
      status === 'approved' ? 9001 : null]);
}
function safeRows(rows: any[], keys: string[]) {
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), keys);
  const text = JSON.stringify(rows);
  assert(!/password|registration|key_hash|reviewed_by|inviter_note|terms_version|NEVER_RETURN/i.test(text));
}

before(async () => {
  const fail = () => { externalCalls++; throw Error('NONFIXTURE_NETWORK_FORBIDDEN'); };
  mock.method(globalThis, 'fetch', fail as any);
  for (const module of [http, https]) {
    mock.method(module, 'request', fail as any); mock.method(module, 'get', fail as any);
  }
  mock.method(tls, 'connect', fail as any);
  const connect = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const path = typeof options === 'string' ? options : options?.path;
    if (path !== `${socket}/.s.PGSQL.55476`) return fail();
    return (connect as any).apply(this, args);
  });
  await closeDb();
  ENV.databaseUrl = `postgresql://invitation_read_local@localhost:55476/postgres?host=${encodeURIComponent(socket!)}`;
  ENV.resendApiKey = ''; ENV.resendWebhookSecret = ''; ENV.bunqApiKey = ''; ENV.forgeApiKey = '';
  ENV.dhlApiKey = ''; ENV.dhlTrackingApiKey = ''; ENV.wawiInternalKey = ''; ENV.adminPassword = '';
  pool = await getPool();
  const connection = (await pool.query('SELECT inet_server_addr() AS address, current_user AS username')).rows[0];
  assert.equal(connection.address, null); assert.equal(connection.username, 'invitation_read_local');
  await pool.query("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'product_manager'");
  await pool.query("INSERT INTO users(id,username,password_hash,role) VALUES(2,'product_manager','unused','product_manager')");
  await ensurePartnerInvitationSchema(); await ensureAdminChangeLogSchema();
  assert.equal(isPermissionsSchemaReady(), false);
  for (const operation of [() => caller().partnerInvitation.pending(), () => caller().partnerInvitation.byDay({ date: '2026-11-26' })]) {
    await assert.rejects(operation(), denied); startupDenied++;
  }
  await ensurePermissionsSchema();
  businessTables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('users','operations_account_capability_grants') ORDER BY tablename"))
    .rows.map((row: any) => row.tablename);
});
beforeEach(async () => {
  await waitForPartnerInvitationMailDispatchesForTests();
  setPartnerInvitationMailTransportForTests(async () => { mailCalls++; throw Error('MAIL_FORBIDDEN'); });
  await pool.query(`TRUNCATE partner_invitation_mail_events,partner_invitation_applications RESTART IDENTITY CASCADE;
    UPDATE users SET username='product_manager',role='product_manager' WHERE id=2;
    UPDATE operations_account_capability_grants SET revoked_at=NULL;`);
  await ensurePermissionsSchema();
  await seed(10, '2026-11-25T22:59:59.999Z');
  await seed(11, '2026-11-25T23:00:00.000Z');
  await seed(12, '2026-11-26T11:00:00.000Z', 'approved');
  await seed(13, '2026-11-26T22:59:59.999Z', 'rejected');
  await seed(14, '2026-11-26T23:00:00.000Z');
  await pool.query(`INSERT INTO partner_invitation_mail_events
    (application_id,kind,recipient_email,recipient_name,subject,text_body,html_body)
    VALUES(11,'registration_acknowledgement','app-11@fixture.invalid','Synthetic 11','Dormant fixture','Fixture only','Fixture only')`);
  beforeState = await snapshot();
});
afterEach(async () => {
  await waitForPartnerInvitationMailDispatchesForTests();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await snapshot(), beforeState, 'read/denied write changed business tables or dormant mail');
  assert.equal(externalCalls, 0); assert.equal(mailCalls, 0); assert.equal(cookies, 0);
});
after(async () => {
  await waitForPartnerInvitationMailDispatchesForTests();
  setPartnerInvitationMailTransportForTests();
  await closeDb(); ENV.databaseUrl = ''; mock.restoreAll();
});

test('actual routes fail closed before permissions readiness and reuse the exact existing user2 read grant', async () => {
  assert.equal(startupDenied, 2); assert.equal(isPermissionsSchemaReady(), true);
  const grants = (await pool.query('SELECT * FROM operations_account_capability_grants ORDER BY capability')).rows;
  assert.equal(grants.length, 4);
  assert(grants.every((g: any) => g.user_id === 2 && g.username === 'product_manager' && g.required_role === 'product_manager'));
  const grant = grants.find((g: any) => g.capability === 'operations_read');
  assert.match(grant.grant_reason, /2026-11-09 Userauthorize.*Pakko/);
  await caller().partnerInvitation.pending(); await caller().partnerInvitation.byDay({ date: '2026-11-26' });
  assert.deepEqual((await pool.query('SELECT * FROM operations_account_capability_grants ORDER BY capability')).rows, grants);
});
test('granted PM pending is pending-only and both outputs are strict whitelists with nullable company/review/link', async () => {
  const pending = await caller().partnerInvitation.pending();
  assert.deepEqual(pending.map(r => r.id), [10, 11, 14]); safeRows(pending, pendingKeys);
  const rows = await caller().partnerInvitation.byDay({ date: '2026-11-26' });
  safeRows(rows, dayKeys);
  assert.deepEqual(rows.map(r => r.id), [11, 12, 13]);
  assert.deepEqual(rows.map(r => r.status), ['pending', 'approved', 'rejected']);
  assert.equal(rows[0].company, null); assert.equal(rows[0].reviewedAt, null); assert.equal(rows[0].partnerId, null);
  assert.equal(rows[1].partnerId, 9001); assert.equal(new Date(rows[1].reviewedAt!).toISOString(), '2026-11-26T12:00:00.000Z');
  assert.equal(rows[2].partnerId, null); assert.equal(rows[0].email, 'app-11@fixture.invalid');
  assert.equal(new Date(rows[0].createdAt).toISOString(), '2026-11-25T23:00:00.000Z');
});
test('public, wrong id, wrong username, other PM, packing and user fail on both actual read routes', async () => {
  for (const principal of [null, { ...pm, id: 3 }, { ...pm, username: 'wrong' }, { ...pm, id: 3, username: 'other_pm' }, { ...pm, role: 'user' }, { ...pm, role: 'packing' }]) {
    await assert.rejects(caller(principal).partnerInvitation.pending(), denied);
    await assert.rejects(caller(principal).partnerInvitation.byDay({ date: '2026-11-26' }), denied);
  }
});
test('current DB account username and role are checked, not just the session principal', async () => {
  for (const sql of ["UPDATE users SET username='renamed' WHERE id=2", "UPDATE users SET username='product_manager',role='user' WHERE id=2"]) {
    await pool.query(sql);
    await assert.rejects(caller().partnerInvitation.pending(), denied);
    await assert.rejects(caller().partnerInvitation.byDay({ date: '2026-11-26' }), denied);
  }
  await pool.query("UPDATE users SET role='product_manager' WHERE id=2");
  assert.equal((await caller().partnerInvitation.byDay({ date: '2026-11-26' })).length, 3);
});
test('read grant revocation denies immediately on the same caller and schema replay never unrevokes', async () => {
  const c = caller(); await c.partnerInvitation.pending(); await c.partnerInvitation.byDay({ date: '2026-11-26' });
  await pool.query("UPDATE operations_account_capability_grants SET revoked_at=NOW() WHERE capability='operations_read'");
  await assert.rejects(c.partnerInvitation.pending(), denied);
  await assert.rejects(c.partnerInvitation.byDay({ date: '2026-11-26' }), denied);
  await ensurePermissionsSchema();
  await assert.rejects(c.partnerInvitation.pending(), denied);
  await assert.rejects(c.partnerInvitation.byDay({ date: '2026-11-26' }), denied);
});
test('missing read grant or mismatched grant identity never inherits other existing capabilities', async () => {
  await pool.query("UPDATE operations_account_capability_grants SET username='wrong' WHERE capability='operations_read'");
  await assert.rejects(caller().partnerInvitation.pending(), denied);
  await assert.rejects(caller().partnerInvitation.byDay({ date: '2026-11-26' }), denied);
  await pool.query("DELETE FROM operations_account_capability_grants WHERE capability='operations_read'");
  await assert.rejects(caller().partnerInvitation.pending(), denied);
  await assert.rejects(caller().partnerInvitation.byDay({ date: '2026-11-26' }), denied);
});
test('admin read access bypasses revoked grants unchanged; review mutations remain admin procedures', async () => {
  await pool.query('UPDATE operations_account_capability_grants SET revoked_at=NOW()');
  assert.deepEqual(await caller(admin).partnerInvitation.pending(), await withReadOnlyDatabase(() => caller(admin).partnerInvitation.pending()));
  assert.equal((await caller(admin).partnerInvitation.byDay({ date: '2026-11-26' })).length, 3);
  const procedures = app._def.procedures as any;
  for (const name of ['pending', 'byDay']) assert.equal(procedures[`partnerInvitation.${name}`]._def.type, 'query');
  for (const name of ['approve', 'reject']) assert.equal(procedures[`partnerInvitation.${name}`]._def.type, 'mutation');
});
test('PM with valid read grant cannot approve or reject any application and creates no mail or mutation', async () => {
  for (const id of [11, 12, 13, 999999]) {
    await assert.rejects(caller().partnerInvitation.approve({ id }), denied);
    await assert.rejects(caller().partnerInvitation.reject({ id }), denied);
  }
});
test('Berlin winter day uses inclusive midnight and exclusive next midnight rather than UTC date', async () => {
  assert.deepEqual((await caller().partnerInvitation.byDay({ date: '2026-11-25' })).map(r => r.id), [10]);
  assert.deepEqual((await caller().partnerInvitation.byDay({ date: '2026-11-26' })).map(r => r.id), [11, 12, 13]);
  assert.deepEqual((await caller().partnerInvitation.byDay({ date: '2026-11-27' })).map(r => r.id), [14]);
  assert.deepEqual(await caller().partnerInvitation.byDay({ date: '2026-11-28' }), []);
});

for (const boundary of [
  { label: 'summer +02', day: '2026-07-01', before: '2026-06-30T21:59:59.999Z', start: '2026-06-30T22:00:00.000Z', last: '2026-07-01T21:59:59.999Z', end: '2026-07-01T22:00:00.000Z' },
  { label: 'spring DST 23-hour day', day: '2026-03-29', before: '2026-03-28T22:59:59.999Z', start: '2026-03-28T23:00:00.000Z', last: '2026-03-29T21:59:59.999Z', end: '2026-03-29T22:00:00.000Z' },
  { label: 'autumn DST 25-hour day', day: '2026-10-25', before: '2026-10-24T21:59:59.999Z', start: '2026-10-24T22:00:00.000Z', last: '2026-10-25T22:59:59.999Z', end: '2026-10-25T23:00:00.000Z' },
]) {
  test(`Berlin ${boundary.label} has exact inclusive/exclusive boundaries`, async () => {
    await seed(20, boundary.before); await seed(21, boundary.start); await seed(22, boundary.last, 'rejected'); await seed(23, boundary.end);
    // Intentional fixture preparation, before the read-only operation under test.
    beforeState = await snapshot();
    assert.deepEqual((await caller().partnerInvitation.byDay({ date: boundary.day })).map(r => r.id), [21, 22]);
  });
}
test('strict real calendar input rejects malformed, impossible, timestamp and injected extra fields safely', async () => {
  for (const input of [{}, { date: '2026-02-30' }, { date: '2026-02-29' }, { date: '2026-13-01' },
    { date: '2026-11-00' }, { date: '2026-1-01' }, { date: '2026-11-26T00:00:00Z' },
    { date: "2026-11-26'; SELECT 1--" }, { date: '2026-11-26', password_hash: 'NEVER_RETURN_SECRET' }]) {
    await assert.rejects(caller().partnerInvitation.byDay(input as any), (e: any) => {
      assert.equal(e.code, 'BAD_REQUEST'); assert(!JSON.stringify(e).includes('NEVER_RETURN_SECRET')); return true;
    });
  }
  assert.deepEqual(await caller().partnerInvitation.byDay({ date: '2028-02-29' }), []);
});
test('both routes succeed in a database-enforced read-only transaction without claiming dormant mail', async () => {
  await withReadOnlyDatabase(async () => {
    assert.equal((await caller().partnerInvitation.pending()).length, 3);
    assert.equal((await caller().partnerInvitation.byDay({ date: '2026-11-26' })).length, 3);
  });
  const event = (await pool.query('SELECT state,attempts,claimed_at,sent_at FROM partner_invitation_mail_events')).rows[0];
  assert.deepEqual(event, { state: 'new', attempts: 0, claimed_at: null, sent_at: null });
});
test('permissions database errors fail closed with no sensitive error detail or fallback role grant', async () => {
  const intercept = mock.method(pool, 'query', async () => { throw Error('NEVER_RETURN_DATABASE_SECRET'); });
  try {
    for (const work of [() => caller().partnerInvitation.pending(), () => caller().partnerInvitation.byDay({ date: '2026-11-26' })]) {
      await assert.rejects(work(), (e: any) => e.code === 'FORBIDDEN' && !e.message.includes('NEVER_RETURN') && e.cause === undefined);
    }
  } finally { intercept.mock.restore(); }
});
