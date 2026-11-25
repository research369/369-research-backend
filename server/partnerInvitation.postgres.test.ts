import assert from 'node:assert/strict';
import test, { before, after, beforeEach, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import bcrypt from 'bcryptjs';
import { ENV } from './env.js';
import { getPool, getDb, closeDb } from './db.js';
import { router } from './trpc.js';
import { partnerInvitationRouter } from './partnerInvitationRouter.js';
import { partnerRouter } from './partnerRouter.js';
import { ensurePartnerInvitationSchema } from './partnerInvitationSchema.js';
import { ensureAccountSecuritySchema } from './accountSecuritySchema.js';
import { ensureAdminChangeLogSchema } from './adminChangeLogService.js';
import { invitationKeyHash } from './partnerInvitationContract.js';
import { invitationIdentifiersAvailable } from './partnerInvitationService.js';
import { orders } from '../drizzle/schema.js';

const socket = process.env.PARTNER_INVITATION_TEST_PG_SOCKET;
if (!socket?.startsWith('/tmp/369-partner-invitation.') || !socket.endsWith('/socket') || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL || process.env.DOTENV_CONFIG_PATH !== '/dev/null' || process.env.PARTNER_INVITATION_TEST_SANITIZED !== '1') throw Error('DEDICATED_UNIX_FIXTURE_REQUIRED');
let pool: any, db: any, externalCalls = 0, cookies = 0;
const admin = { id: 1, username: 'synthetic_admin', role: 'admin', name: null, email: null };
const context = (principal: any = null, ip = 'local-synthetic-peer') => ({ req: { headers: {}, ip, socket: { remoteAddress: ip } }, res: { cookie() { cookies++; } }, user: principal }) as any;
const app = router({ partnerInvitation: partnerInvitationRouter, partner: partnerRouter });
const caller = (principal: any = null, ip?: string) => app.createCaller(context(principal, ip));
const valid = (email = 'new@fixture.invalid') => ({ registrationKey: randomUUID(), name: 'Synthetic Invitee', email, phone: '+49000000', company: 'Fixture GmbH', password: 'Synthetic-password-123', passwordConfirm: 'Synthetic-password-123', agreeToTerms: true as const, termsVersion: 'ben-10-10-v1' as const, website: '' as const });
const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
const appRow = async (email = 'new@fixture.invalid') => (await pool.query('SELECT * FROM partner_invitation_applications WHERE email=$1', [email])).rows[0];
const submitAndId = async (input = valid()) => { await caller().partnerInvitation.submit(input); return Number((await appRow(input.email)).id); };
async function unchangedSnapshot() {
  const tables = ['partners', 'partner_codes', 'partner_programs', 'kwk_accounts', 'kwk_ledger', 'kwk_referrals', 'orders', 'order_items', 'partner_transactions', 'promo_codes', 'shop_settings', 'articles'];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`, []).catch(async (e: any) => {
    if (e.code !== '42703') throw e;
    return pool.query(`SELECT * FROM ${table} ORDER BY key`);
  })).rows;
  return result;
}
before(async () => {
  const fail = () => { externalCalls++; throw Error('NONFIXTURE_NETWORK_FORBIDDEN'); };
  mock.method(globalThis, 'fetch', fail as any);
  mock.method(http, 'request', fail as any); mock.method(http, 'get', fail as any);
  mock.method(https, 'request', fail as any); mock.method(https, 'get', fail as any);
  const connect = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const first = args[0];
    const options = Array.isArray(first) ? first[0] : first;
    const path = typeof options === 'string' ? options : options?.path;
    if (typeof path !== 'string' || path !== `${socket}/.s.PGSQL.55465`) return fail();
    return (connect as any).apply(this, args);
  });
  await closeDb();
  ENV.databaseUrl = `postgresql://invitation_local@localhost:55465/postgres?host=${encodeURIComponent(socket!)}`;
  ENV.resendApiKey = ''; ENV.bunqApiKey = ''; ENV.forgeApiKey = ''; ENV.dhlApiKey = ''; ENV.dhlTrackingApiKey = '';
  pool = await getPool(); db = await getDb();
  await ensureAccountSecuritySchema(); await ensureAdminChangeLogSchema();
  await ensurePartnerInvitationSchema(); await ensurePartnerInvitationSchema();
});
beforeEach(async () => {
  // Wait for existing nonblocking admin journal promises before resetting fixture only.
  await new Promise(resolve => setTimeout(resolve, 30));
  await pool.query(`TRUNCATE partner_invitation_applications, partner_codes, partners, partner_programs, kwk_accounts, kwk_ledger, kwk_referrals,
    orders, order_items, partner_transactions, promo_codes, shop_settings, articles, account_auth_rate_limits, admin_change_events RESTART IDENTITY CASCADE;
    INSERT INTO partner_programs(key,label,customer_discount_policy,commission_policy,settlement_method,allow_self_order_credit,active)
    VALUES('creator','Creator','each_valid_code_use','each_paid_code_order','payout',false,true),
      ('partner','Partner','first_paid_code_use','first_paid_code_order','shop_credit',true,true);
    INSERT INTO partners(id,name,email,phone,company,code,partner_number,program_key,commission_type,commission_percent,customer_discount_percent,credit_balance,password_hash,notes)
    VALUES(9001,'Untouched Partner','  EXISTING@fixture.invalid  ','original','Original Company','ORIGINAL, LEGACY10','ORIGINAL-9001','partner','dauerhaft',7,3,12.34,'UNCHANGED_HASH','Original notes');
    INSERT INTO partner_codes(partner_id,display_code,code_normalized,commission_percent,customer_discount_percent)
    VALUES(9001,'ORIGINAL','ORIGINAL',7,3);
    INSERT INTO kwk_accounts(id,kwk_number,referral_code,name,email,phone,password_hash,credit_available)
    VALUES(9001,'KWK-9001','KWK-9001','Untouched KWK','kwk@fixture.invalid','original','UNCHANGED_KWK_HASH',8);
    INSERT INTO promo_codes(code,percentage,description) VALUES('NORMAL10',10,'ordinary combinable promo'),('EXCLUSIVE90',90,'existing exclusive campaign');
    INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount','existing'),('exclusive_campaign','untouched');
    INSERT INTO articles(sku,name,stock,is_active) VALUES('FIXTURE','Untouched stock',10,1);`);
  await db.insert(orders).values({ orderId: 'UNCHANGED-ORDER', firstName: 'Synthetic', lastName: 'Owner', email: 'owner@fixture.invalid', phone: '', street: 'Local', houseNumber: '1', zip: '00000', city: 'Local', country: 'DE', subtotal: '100', discount: '10', shipping: '5', shippingCountry: 'DE', total: '95', paymentMethod: 'SEPA', status: 'offen', orderDate: new Date('2026-11-01T00:00:00Z') });
  cookies = 0;
});
after(async () => { await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(externalCalls, 0); await closeDb(); ENV.databaseUrl = ''; mock.restoreAll(); });

test('submission stays pending with hashed immutable credentials and creates no partner/token/mail/order/stock change', async () => {
  const before = await unchangedSnapshot(); const input = valid();
  const result = await caller().partnerInvitation.submit(input);
  assert.deepEqual(result, { status: 'pending' }); assert.equal(cookies, 0);
  const row = await appRow(); assert.equal(row.status, 'pending'); assert.equal(row.linked_partner_id, null);
  assert.equal(row.registration_key_hash, invitationKeyHash(input.registrationKey));
  assert.match(row.password_hash, /^\$2[aby]\$12\$/); assert(await bcrypt.compare(input.password, row.password_hash));
  assert(!JSON.stringify(result).includes(input.password)); assert(!JSON.stringify(result).includes(row.password_hash));
  assert.deepEqual(await unchangedSnapshot(), before); assert.equal(externalCalls, 0);
});
test('approval uses fixed 10/10 creator payout, canonical active code, zero balance and audits actor', async () => {
  const input = valid(); const id = await submitAndId(input);
  const result = await caller(admin).partnerInvitation.approve({ id });
  assert.equal(result.status, 'approved'); assert.equal(result.id, id);
  assert.match(result.code!, /^BEN-SYNTHETICINVITEE10-[A-F0-9]{12}$/); assert.match(result.partnerNumber!, /^BEN-[A-F0-9]{16}$/);
  const row = (await pool.query('SELECT * FROM partners WHERE id=$1', [result.partnerId])).rows[0];
  assert.equal(row.program_key, 'creator'); assert.equal(row.commission_type, 'einmalig');
  assert.equal(Number(row.commission_percent), 10); assert.equal(Number(row.customer_discount_percent), 10);
  assert.equal(Number(row.credit_balance), 0); assert.equal(row.is_active, 1); assert.equal(row.last_login, null);
  assert.equal(row.password_hash, (await appRow()).password_hash); assert.match(row.notes, /CEO Ben.*ben-10-10-v1/);
  const code = (await pool.query('SELECT * FROM partner_codes WHERE partner_id=$1', [row.id])).rows;
  assert.equal(code.length, 1); assert.equal(code[0].display_code, row.code); assert.equal(code[0].code_normalized, row.code);
  assert.equal(code[0].is_active, true); assert.equal(Number(code[0].commission_percent), 10); assert.equal(Number(code[0].customer_discount_percent), 10);
  const reviewed = await appRow(); assert.equal(reviewed.reviewed_by, admin.username); assert(reviewed.reviewed_at);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await pool.query("SELECT actor FROM admin_change_events WHERE action='partnerInvitation.approve'")).rows[0].actor, admin.username);
  assert.equal(await count('partner_transactions'), 0); assert.equal(cookies, 0);
  assert.deepEqual(await caller().partnerInvitation.status({ registrationKey: input.registrationKey }), { status: 'approved', partnerNumber: result.partnerNumber, code: result.code });
});
test('concurrent and retry approval creates exactly one partner and one code with stable identity', async () => {
  const id = await submitAndId();
  const results = await Promise.all(Array.from({ length: 8 }, () => caller(admin).partnerInvitation.approve({ id })));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(await caller(admin).partnerInvitation.approve({ id }), results[0]);
  assert.equal(await count('partners'), 2); assert.equal(await count('partner_codes'), 2);
});
test('duplicate and concurrent submits cannot replace key, personal data or password', async () => {
  const input = valid();
  await Promise.all(Array.from({ length: 5 }, () => caller().partnerInvitation.submit(input)));
  assert.equal(await count('partner_invitation_applications'), 1);
  const old = await appRow();
  await caller().partnerInvitation.submit({ ...input, name: 'Changed Name', password: 'Other-password-123', passwordConfirm: 'Other-password-123' });
  await caller().partnerInvitation.submit({ ...input, registrationKey: randomUUID() });
  await caller().partnerInvitation.submit({ ...input, email: 'different@fixture.invalid' });
  assert.deepEqual(await appRow(), old); assert.equal(await count('partner_invitation_applications'), 1);
});
test('owned same key/email returns current state; wrong recovery key never exposes identity or enumeration', async () => {
  const input = valid(); const id = await submitAndId(input);
  const approved = await caller(admin).partnerInvitation.approve({ id });
  assert.deepEqual(await caller().partnerInvitation.submit(input), { status: 'approved', partnerNumber: approved.partnerNumber, code: approved.code });
  assert.deepEqual(await caller().partnerInvitation.status({ registrationKey: randomUUID() }), { status: 'pending' });
  assert.deepEqual(await caller().partnerInvitation.submit({ ...input, registrationKey: randomUUID() }), { status: 'pending' });
  assert.deepEqual(await caller().partnerInvitation.submit({ ...input, email: 'wrong@fixture.invalid' }), { status: 'pending' });
});
test('existing normalized partner email gets generic acknowledgement and never attaches or overwrites', async () => {
  const before = await unchangedSnapshot(); const input = valid(' EXISTING@fixture.invalid ');
  assert.deepEqual(await caller().partnerInvitation.submit(input), { status: 'pending' });
  assert.equal(await count('partner_invitation_applications'), 0);
  assert.deepEqual(await caller().partnerInvitation.status({ registrationKey: input.registrationKey }), { status: 'pending' });
  assert.deepEqual(await unchangedSnapshot(), before);
});
test('email introduced by another admin after submission blocks approval without modifying either account', async () => {
  const id = await submitAndId();
  await pool.query("UPDATE partners SET email=' NEW@fixture.invalid ' WHERE id=9001");
  const before = await unchangedSnapshot();
  await assert.rejects(caller(admin).partnerInvitation.approve({ id }), (e: any) => e.code === 'CONFLICT');
  assert.deepEqual(await unchangedSnapshot(), before); assert.equal((await appRow()).status, 'pending');
});
test('rejection is inert, retry-safe, recoverable only by key and cannot be approved', async () => {
  const input = valid(); const id = await submitAndId(input); const before = await unchangedSnapshot();
  assert.deepEqual(await caller(admin).partnerInvitation.reject({ id }), { id, status: 'rejected' });
  assert.deepEqual(await caller(admin).partnerInvitation.reject({ id }), { id, status: 'rejected' });
  await assert.rejects(caller(admin).partnerInvitation.approve({ id }), (e: any) => e.code === 'CONFLICT');
  assert.deepEqual(await caller().partnerInvitation.status({ registrationKey: input.registrationKey }), { status: 'rejected' });
  assert.deepEqual(await caller().partnerInvitation.submit(input), { status: 'rejected' });
  assert.deepEqual(await unchangedSnapshot(), before);
});
test('public, product_manager (including special id 2), packing and user cannot list/approve/reject', async () => {
  const id = await submitAndId();
  for (const principal of [null, { ...admin, id: 2, username: 'product_manager', role: 'product_manager' }, { ...admin, role: 'packing' }, { ...admin, role: 'user' }]) {
    for (const work of [() => caller(principal).partnerInvitation.pending(), () => caller(principal).partnerInvitation.approve({ id }), () => caller(principal).partnerInvitation.reject({ id })]) {
      await assert.rejects(work(), (e: any) => ['UNAUTHORIZED', 'FORBIDDEN'].includes(e.code));
    }
  }
  assert.equal((await appRow()).status, 'pending'); assert.equal(await count('partners'), 1);
});
test('actual router strict input rejects commercial overrides/password mismatch/honeypot before storage', async () => {
  for (const patch of [{ commissionPercent: 99 }, { customerDiscountPercent: 99 }, { code: 'CHOSEN' }, { programKey: 'partner' }, { status: 'approved' }, { website: 'bot' }, { passwordConfirm: 'Mismatch-password-123' }]) {
    await assert.rejects(caller().partnerInvitation.submit({ ...valid(), ...patch } as any), (e: any) => e.code === 'BAD_REQUEST');
  }
  assert.equal(await count('partner_invitation_applications'), 0); assert.equal(await count('partners'), 1);
  assert.equal(await count('account_auth_rate_limits'), 0);
});
test('existing DB-backed submit/status rate scopes enforced with only hashed identifiers', async () => {
  const input = valid();
  for (let i = 0; i < 10; i++) await caller().partnerInvitation.submit(input);
  await assert.rejects(caller().partnerInvitation.submit(input), (e: any) => e.code === 'TOO_MANY_REQUESTS');
  for (let i = 0; i < 10; i++) await caller().partnerInvitation.status({ registrationKey: input.registrationKey });
  await assert.rejects(caller().partnerInvitation.status({ registrationKey: input.registrationKey }), (e: any) => e.code === 'TOO_MANY_REQUESTS');
  const rows = (await pool.query('SELECT * FROM account_auth_rate_limits')).rows;
  assert.equal(rows.length, 4); assert(rows.every((r: any) => /^[a-f0-9]{64}$/.test(r.bucket_hash)));
  assert(!JSON.stringify(rows).includes(input.email)); assert(!JSON.stringify(rows).includes(input.registrationKey));
});
test('shared IP limit cannot be bypassed by forged forwarding headers or changing email/key', async () => {
  for (let i = 0; i < 30; i++) {
    const ctx = context(null, 'shared-synthetic-peer'); ctx.req.headers = { 'x-forwarded-for': `198.51.100.${i}` };
    await app.createCaller(ctx).partnerInvitation.status({ registrationKey: randomUUID() });
  }
  await assert.rejects(caller(null, 'shared-synthetic-peer').partnerInvitation.status({ registrationKey: randomUUID() }), (e: any) => e.code === 'TOO_MANY_REQUESTS');
});
test('admin pending list is bounded and whitelisted without keys/hashes/passwords', async () => {
  const hash = await bcrypt.hash('Synthetic-password-123', 12);
  for (let i = 0; i < 105; i++) await pool.query(`INSERT INTO partner_invitation_applications(registration_key_hash,email,name,phone,password_hash,terms_version)
    VALUES($1,$2,'Synthetic','123',$3,'ben-10-10-v1')`, [invitationKeyHash(randomUUID()), `list-${i}@fixture.invalid`, hash]);
  const pending = await caller(admin).partnerInvitation.pending(); assert.equal(pending.length, 100);
  assert.deepEqual(Object.keys(pending[0]).sort(), ['id','name','email','phone','company','createdAt'].sort());
  assert(!JSON.stringify(pending).includes(hash)); assert(!JSON.stringify(pending).includes('registration'));
});
test('approval code/application transaction rolls back fully if canonical code insertion fails', async () => {
  const id = await submitAndId();
  await pool.query(`CREATE FUNCTION invitation_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture sensitive database detail'; END $$;
    CREATE TRIGGER invitation_fixture_fail BEFORE INSERT ON partner_codes FOR EACH ROW EXECUTE FUNCTION invitation_fixture_fail()`);
  try {
    await assert.rejects(caller(admin).partnerInvitation.approve({ id }), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && !e.message.includes('sensitive') && e.cause === undefined);
    assert.equal(await count('partners'), 1); assert.equal(await count('partner_codes'), 1); assert.equal((await appRow()).status, 'pending');
  } finally { await pool.query('DROP TRIGGER invitation_fixture_fail ON partner_codes; DROP FUNCTION invitation_fixture_fail()'); }
  assert.equal((await caller(admin).partnerInvitation.approve({ id })).status, 'approved');
});
test('missing/changed creator payout configuration fails closed and never changes program settings', async () => {
  const id = await submitAndId();
  await pool.query("UPDATE partner_programs SET settlement_method='shop_credit' WHERE key='creator'");
  const before = await unchangedSnapshot();
  await assert.rejects(caller(admin).partnerInvitation.approve({ id }), (e: any) => e.code === 'PRECONDITION_FAILED');
  assert.deepEqual(await unchangedSnapshot(), before); assert.equal((await appRow()).status, 'pending');
});
test('approval preserves unrelated partners/KWK/orders/discount campaigns/settings/stock byte-for-byte', async () => {
  const before = await unchangedSnapshot(); const id = await submitAndId(); const result = await caller(admin).partnerInvitation.approve({ id });
  const after = await unchangedSnapshot();
  after.partners = (after.partners as any[]).filter(p => p.id !== result.partnerId);
  after.partner_codes = (after.partner_codes as any[]).filter(p => p.partner_id !== result.partnerId);
  assert.deepEqual(after, before); assert.equal(await count('partner_transactions'), 0); assert.equal(await count('kwk_ledger'), 0);
});
test('51-60 character phone remains exact in application and new-partner notes without global schema changes', async () => {
  const input = { ...valid(), phone: '+'.padEnd(60, '1') }; const id = await submitAndId(input);
  const result = await caller(admin).partnerInvitation.approve({ id });
  const partner = (await pool.query('SELECT phone,notes FROM partners WHERE id=$1', [result.partnerId])).rows[0];
  assert.equal((await appRow()).phone, input.phone); assert.equal(partner.phone, null); assert(partner.notes.includes(input.phone));
});
test('existing portal login accepts approved password; public invitation never issues a session', async () => {
  const input = valid(); const id = await submitAndId(input); const result = await caller(admin).partnerInvitation.approve({ id });
  assert.equal(cookies, 0);
  const login = await caller().partner.portalLogin({ partnerNumber: result.partnerNumber!, password: input.password });
  assert.equal(login.success, true); assert.equal(login.partner.id, result.partnerId); assert.equal(cookies, 1);
  assert.equal(login.partner.programKey, 'creator'); assert(!JSON.stringify(login).includes(input.password));
});
test('schema migration is additive only; transport exposes info GET and keyed status POST, never public activation', () => {
  const migration = readFileSync(new URL('../drizzle/migrations/0035_partner_invitation_applications.sql', import.meta.url), 'utf8');
  assert(!/^\s*(?:UPDATE|DELETE|TRUNCATE|ALTER TABLE)\b/im.test(migration));
  const procedures = app._def.procedures as any;
  assert.equal(procedures['partnerInvitation.info']._def.type, 'query');
  for (const path of ['submit', 'status', 'approve', 'reject']) assert.equal(procedures[`partnerInvitation.${path}`]._def.type, 'mutation');
});

test('collision preflight covers canonical/legacy CSV/numbers/active promos case-insensitively', async () => {
  const available = (code: string, partnerNumber = 'BEN-UNUSED') => invitationIdentifiersAvailable(pool, { code, partnerNumber });
  assert.equal(await available('ORIGINAL'), false);
  assert.equal(await available('LEGACY10'), false);
  assert.equal(await available('NORMAL10'), false);
  assert.equal(await available('BEN-UNUSED', 'ORIGINAL-9001'), false);
  await pool.query("UPDATE partner_codes SET display_code='mixed-code',code_normalized='mixed-code' WHERE partner_id=9001; UPDATE promo_codes SET code='mixed-promo' WHERE code='NORMAL10'");
  assert.equal(await available('MIXED-CODE'), false); assert.equal(await available('MIXED-PROMO'), false);
  await pool.query("UPDATE promo_codes SET is_active=0 WHERE code='mixed-promo'");
  assert.equal(await available('MIXED-PROMO'), true); assert.equal(await available('BEN-UNUSED'), true);
});
test('approval retries occupied identifiers and fails safely if all candidates collide', { timeout: 15000 }, async () => {
  const id = await submitAndId();
  const connect = pool.connect.bind(pool); let probes = 0; let alwaysOccupied = true;
  const intercept = mock.method(pool, 'connect', (callback?: any) => {
    // pool.query uses callback-style connect; transaction service uses promises.
    if (typeof callback === 'function') return connect(callback);
    return connect().then((client: any) => ({ release: () => client.release(), query: async (sql: string, params?: any[]) => {
      if (sql.includes('AS occupied')) { probes++; if (alwaysOccupied || probes <= 2) return { rows: [{ occupied: true }] }; }
      return client.query(sql, params);
    } }));
  });
  try {
    await assert.rejects(caller(admin).partnerInvitation.approve({ id }), (e: any) => e.code === 'SERVICE_UNAVAILABLE');
    assert.equal(probes, 12); assert.equal(await count('partners'), 1); assert.equal((await appRow()).status, 'pending');
    probes = 0; alwaysOccupied = false;
    assert.equal((await caller(admin).partnerInvitation.approve({ id })).status, 'approved'); assert.equal(probes, 3);
  } finally { intercept.mock.restore(); }
});
test('distinct simultaneous approvals each create only their own fixed account', async () => {
  const ids = await Promise.all([submitAndId(valid('first@fixture.invalid')), submitAndId(valid('second@fixture.invalid'))]);
  const results = await Promise.all(ids.map(id => caller(admin).partnerInvitation.approve({ id })));
  assert.notEqual(results[0].partnerId, results[1].partnerId); assert.notEqual(results[0].code, results[1].code);
  assert.equal(await count('partners'), 3); assert.equal(await count('partner_codes'), 3);
});
test('invalid input errors never include raw key, passwords, PII or arbitrary field names', async () => {
  const input = valid();
  await assert.rejects(caller().partnerInvitation.submit({ ...input, termsVersion: input.registrationKey, [input.password]: input.email } as any), (e: any) => {
    assert.equal(e.code, 'BAD_REQUEST');
    const text = e.message + JSON.stringify(e.cause || null);
    for (const secret of [input.registrationKey, input.password, input.email]) assert(!text.includes(secret));
    return true;
  });
  assert.equal(await count('partner_invitation_applications'), 0);
});
test('invitation schema/database failure remains local, generic, retryable; public info does not use DB', async () => {
  const query = mock.method(pool, 'query', async () => { throw Error('sensitive fixture PII password registration key'); });
  try {
    await assert.rejects(caller(admin).partnerInvitation.pending(), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && !e.message.includes('sensitive') && e.cause === undefined);
    const info = await caller().partnerInvitation.info(); assert.equal(info.enabled, true); assert.equal(info.requiresApproval, true);
  } finally { query.mock.restore(); }
  assert.deepEqual(await caller(admin).partnerInvitation.pending(), []);
});
test('approved application cannot be rejected and public/keyed operations never return credentials/PII', async () => {
  const input = valid(); const id = await submitAndId(input); const approved = await caller(admin).partnerInvitation.approve({ id });
  await assert.rejects(caller(admin).partnerInvitation.reject({ id }), (e: any) => e.code === 'CONFLICT');
  const status = await caller().partnerInvitation.status({ registrationKey: input.registrationKey });
  for (const result of [approved, status, await caller().partnerInvitation.submit(input)]) {
    const text = JSON.stringify(result);
    for (const secret of [input.registrationKey, input.password, input.email, input.phone, input.name, input.company, (await appRow()).password_hash]) assert(!text.includes(secret));
  }
  assert.equal((await appRow()).status, 'approved'); assert.equal(cookies, 0);
});
test('invitation audit link never adds a new restriction to existing partner deletion paths', async () => {
  const input = valid(); const id = await submitAndId(input);
  const approved = await caller(admin).partnerInvitation.approve({ id });
  await pool.query('DELETE FROM partner_codes WHERE partner_id=$1', [approved.partnerId]);
  await pool.query('DELETE FROM partners WHERE id=$1', [approved.partnerId]);
  const audit = await appRow(input.email);
  assert.equal(audit.status, 'approved'); assert.equal(audit.linked_partner_id, approved.partnerId);
  assert.equal(await count('partners'), 1);
  await assert.rejects(caller().partnerInvitation.status({ registrationKey: input.registrationKey }), (e: any) => e.code === 'SERVICE_UNAVAILABLE');
});
