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
import { dispatchPartnerInvitationMailEvent, enqueuePartnerInvitationMail, setPartnerInvitationMailTransportForTests, waitForPartnerInvitationMailDispatchesForTests, type MailEvent } from './partnerInvitationMailService.js';
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
  await waitForPartnerInvitationMailDispatchesForTests();
  setPartnerInvitationMailTransportForTests(); ENV.resendApiKey = '';
  // Wait for existing nonblocking admin journal promises before resetting fixture only.
  await new Promise(resolve => setTimeout(resolve, 30));
  await pool.query(`TRUNCATE partner_invitation_mail_events, partner_invitation_applications, partner_codes, partners, partner_programs, kwk_accounts, kwk_ledger, kwk_referrals,
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
after(async () => {
  await waitForPartnerInvitationMailDispatchesForTests();
  setPartnerInvitationMailTransportForTests(); ENV.resendApiKey = '';
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(externalCalls, 0);
  await closeDb(); ENV.databaseUrl = ''; mock.restoreAll();
});

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
  assert.equal(result.code!, 'SYNTHETIC10'); assert.match(result.partnerNumber!, /^P-[A-F0-9]{16}$/);
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
test('approval retries an occupied primary name10 code with a short neutral random suffix', async () => {
  await pool.query("INSERT INTO promo_codes(code,percentage,description) VALUES('SYNTHETIC10',10,'occupied primary fixture')");
  const promoBefore = (await pool.query("SELECT * FROM promo_codes WHERE code='SYNTHETIC10'")).rows;
  const id = await submitAndId();
  const result = await caller(admin).partnerInvitation.approve({ id });
  assert.equal(result.status, 'approved'); assert.match(result.code!, /^SYNTHETIC10[A-Z0-9]{4}$/);
  assert(result.code!.length <= 16); assert(!result.code!.startsWith('BEN-'));
  assert.match(result.partnerNumber!, /^P-[A-F0-9]{16}$/);
  assert.deepEqual((await pool.query("SELECT * FROM promo_codes WHERE code='SYNTHETIC10'")).rows, promoBefore);
  const codes = (await pool.query('SELECT display_code,code_normalized FROM partner_codes WHERE partner_id=$1', [result.partnerId])).rows;
  assert.deepEqual(codes, [{ display_code: result.code, code_normalized: result.code }]);
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

// Mail tests use only synthetic local rows, injected transports, or a temporary
// fetch stub. The original deny-all fetch/http/socket guards stay in force.
const mailRows = async () => (await pool.query('SELECT * FROM partner_invitation_mail_events ORDER BY id')).rows;
const mailRow = async (id: number) => (await pool.query('SELECT * FROM partner_invitation_mail_events WHERE id=$1', [id])).rows[0];
function captureMails() {
  const events: MailEvent[] = [];
  ENV.resendApiKey = 'synthetic-mail-key-never-live';
  setPartnerInvitationMailTransportForTests(async event => { events.push(event); return { ok: true, providerId: `fixture-${event.id}` }; });
  return events;
}
async function historicalApplication(input = valid('historical@fixture.invalid'), approved = false) {
  const result = await pool.query(`INSERT INTO partner_invitation_applications
    (registration_key_hash,email,name,phone,company,password_hash,terms_version,created_at,status,linked_partner_id,reviewed_at,reviewed_by)
    VALUES($1,$2,$3,$4,$5,'HISTORICAL_SYNTHETIC_HASH','ben-10-10-v1','2020-01-01', $6,$7,$8,$9) RETURNING id`,
    [invitationKeyHash(input.registrationKey), input.email, input.name, input.phone, input.company,
      approved ? 'approved' : 'pending', approved ? 9001 : null, approved ? new Date('2020-01-02') : null, approved ? 'historical_admin' : null]);
  return Number(result.rows[0].id);
}
async function dormantEvent(input = valid('dormant@fixture.invalid')) {
  const id = await historicalApplication(input);
  const eventId = await enqueuePartnerInvitationMail(pool, { id, name: input.name, email: input.email }, 'registration_acknowledgement');
  assert.equal(typeof eventId, 'number');
  return eventId!;
}
async function withProviderFetch(fetchStub: typeof fetch, work: () => Promise<void>) {
  const guardedFetch = globalThis.fetch;
  ENV.resendApiKey = 'synthetic-mail-key-never-live'; setPartnerInvitationMailTransportForTests();
  globalThis.fetch = fetchStub;
  try { await work(); }
  finally { await waitForPartnerInvitationMailDispatchesForTests(); globalThis.fetch = guardedFetch; ENV.resendApiKey = ''; }
}
function assertTerminal(row: any, state: string, code: string | null) {
  assert.equal(row.state, state); assert.equal(row.attempts, 1); assert(row.claimed_at);
  assert.equal(row.last_error_code, code);
  if (state !== 'sent') { assert.equal(row.provider_id, null); assert.equal(row.sent_at, null); }
}

test('mail: readiness is persistent and PII-free, with absent/present runtime key and no backfill', async () => {
  const input = valid('readiness-history@fixture.invalid'); await historicalApplication(input);
  const before = await caller().partnerInvitation.mailReady();
  assert.deepEqual(Object.keys(before).sort(), ['ready', 'activationAt', 'registrationMail', 'approvalMail'].sort());
  assert.equal(before.ready, false); assert.equal(before.registrationMail, false); assert.equal(before.approvalMail, false);
  assert(before.activationAt); assert(Number.isFinite(Date.parse(before.activationAt!)));
  const events = captureMails();
  const ready = await caller().partnerInvitation.mailReady();
  assert.deepEqual(ready, { ready: true, activationAt: before.activationAt, registrationMail: true, approvalMail: true });
  await ensurePartnerInvitationSchema(); await ensurePartnerInvitationSchema();
  assert.deepEqual(await caller().partnerInvitation.mailReady(), ready);
  await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(await count('partner_invitation_mail_activation'), 1); assert.equal(await count('partner_invitation_mail_events'), 0); assert.equal(events.length, 0);
  for (const secret of [input.email, input.name, input.registrationKey, input.password, ENV.resendApiKey]) assert(!JSON.stringify(ready).includes(secret));
});

test('mail: readiness and duplicate historical submit cannot scan or claim an unrelated dormant event', async () => {
  const events = captureMails(); const input = valid('old-pending@fixture.invalid'); await historicalApplication(input);
  const dormant = await dormantEvent();
  await caller().partnerInvitation.mailReady(); await caller(admin).partnerInvitation.pending();
  await caller().partnerInvitation.submit(input); await caller().partnerInvitation.status({ registrationKey: input.registrationKey });
  await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(events.length, 0); assert.equal((await mailRow(dormant)).state, 'new'); assert.equal((await mailRow(dormant)).attempts, 0);
  assert.equal((await mailRows()).length, 1); assert.equal((await appRow(input.email)).status, 'pending');
});

test('mail: new submission emits exactly one acknowledgement, never password/key/hash or premature code', async () => {
  const events = captureMails(); const input = valid(); const id = await submitAndId(input);
  await waitForPartnerInvitationMailDispatchesForTests();
  await caller().partnerInvitation.submit(input); await caller().partnerInvitation.submit({ ...input, registrationKey: randomUUID() });
  await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(events.length, 1); assert.equal(events[0].applicationId, id); assert.equal(events[0].kind, 'registration_acknowledgement');
  assert.equal(events[0].recipientEmail, input.email); assert.equal(events[0].partnerCode, null); assert.equal(events[0].partnerNumber, null);
  const text = events[0].textBody + events[0].htmlBody;
  assert.match(text, /noch nicht freigeschaltet/); assert.match(text, /10 %/); assert(!/P-[A-F0-9]{16}\b/.test(text)); assert(!text.includes('SYNTHETIC10'));
  for (const secret of [input.password, input.registrationKey, (await appRow()).password_hash]) assert(!JSON.stringify(events).includes(secret));
  const rows = await mailRows(); assert.equal(rows.length, 1); assertTerminal(rows[0], 'sent', null); assert(rows[0].sent_at);
});

test('mail: genuine approval sends exact committed identity and correct portal/payout instructions once', async () => {
  const events = captureMails(); const input = valid(); const id = await submitAndId(input);
  await waitForPartnerInvitationMailDispatchesForTests(); const approved = await caller(admin).partnerInvitation.approve({ id });
  await waitForPartnerInvitationMailDispatchesForTests();
  assert.deepEqual(events.map(e => e.kind), ['registration_acknowledgement', 'approval']);
  const event = events[1]; assert.equal(event.partnerCode, approved.code); assert.equal(event.partnerNumber, approved.partnerNumber);
  assert.equal(event.applicationId, id); assert.equal(event.recipientEmail, input.email);
  for (const body of [event.textBody, event.htmlBody]) {
    assert(body.includes(approved.code!)); assert(body.includes(approved.partnerNumber!)); assert(body.includes('https://www.369research.eu/partner'));
    assert.match(body, /10 %/); assert.match(body, /9 € Provision/); assert.match(body, /Versandkosten/); assert.match(body, /exklusive/);
    assert.match(body, /Bankverbindung/); assert.match(body, /Bitte sende keine Bankdaten per E-Mail/);
    assert(!body.includes(input.password)); assert(!body.includes(input.registrationKey));
  }
  assert.equal((await appRow()).status, 'approved'); assert.equal((await mailRows()).filter((r: any) => r.kind === 'approval').length, 1);
});

test('mail: historical pending application approved today receives approval only, never retroactive registration', async () => {
  const events = captureMails(); const input = valid('old-pending@fixture.invalid'); const id = await historicalApplication(input);
  await caller().partnerInvitation.submit(input); await waitForPartnerInvitationMailDispatchesForTests(); assert.equal(events.length, 0);
  const approved = await caller(admin).partnerInvitation.approve({ id });
  await caller(admin).partnerInvitation.approve({ id }); await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'approval'); assert.equal(events[0].partnerCode, approved.code);
  assert.deepEqual((await mailRows()).map((r: any) => r.kind), ['approval']);
});

test('mail: already-approved historical applications and retry/history reads create no event or dispatch', async () => {
  const events = captureMails(); const input = valid('already-approved@fixture.invalid'); const id = await historicalApplication(input, true);
  const dormant = await dormantEvent();
  await Promise.all(Array.from({ length: 4 }, () => caller(admin).partnerInvitation.approve({ id })));
  await caller().partnerInvitation.submit(input); await caller().partnerInvitation.status({ registrationKey: input.registrationKey });
  await caller().partnerInvitation.mailReady(); await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(events.length, 0); assert.equal((await mailRows()).length, 1); assert.equal((await mailRow(dormant)).state, 'new');
});

test('mail: rejected and unauthorized/nonexistent approvals never enqueue approval', async () => {
  const events = captureMails(); const id = await submitAndId(); await waitForPartnerInvitationMailDispatchesForTests();
  await assert.rejects(caller().partnerInvitation.approve({ id })); await caller(admin).partnerInvitation.reject({ id });
  await assert.rejects(caller(admin).partnerInvitation.approve({ id }), (e: any) => e.code === 'CONFLICT');
  await assert.rejects(caller(admin).partnerInvitation.approve({ id: 999999 }), (e: any) => e.code === 'NOT_FOUND');
  await waitForPartnerInvitationMailDispatchesForTests();
  assert.deepEqual(events.map(e => e.kind), ['registration_acknowledgement']); assert.equal((await mailRows()).length, 1);
});

test('mail: email conflict and failed creator precondition do not enqueue approval or scan dormant events', async () => {
  const events = captureMails(); const first = await submitAndId(valid('conflicted@fixture.invalid'));
  const second = await submitAndId(valid('precondition@fixture.invalid')); await waitForPartnerInvitationMailDispatchesForTests();
  const dormant = await dormantEvent(); await pool.query("UPDATE partners SET email='conflicted@fixture.invalid' WHERE id=9001");
  await assert.rejects(caller(admin).partnerInvitation.approve({ id: first }), (e: any) => e.code === 'CONFLICT');
  await pool.query("UPDATE partner_programs SET active=false WHERE key='creator'");
  await assert.rejects(caller(admin).partnerInvitation.approve({ id: second }), (e: any) => e.code === 'PRECONDITION_FAILED');
  await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(events.length, 2); assert(events.every(e => e.kind === 'registration_acknowledgement'));
  assert.equal((await mailRow(dormant)).state, 'new'); assert.equal((await mailRows()).filter((r: any) => r.kind === 'approval').length, 0);
});

test('mail: approval and registration rollback after enqueue leave neither committed event nor transport call', async () => {
  const events = captureMails(); const id = await historicalApplication();
  await pool.query(`CREATE FUNCTION invitation_mail_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic forced rollback'; END $$;
    CREATE TRIGGER invitation_mail_fixture_fail AFTER INSERT ON partner_invitation_mail_events FOR EACH ROW EXECUTE FUNCTION invitation_mail_fixture_fail()`);
  try {
    await assert.rejects(caller(admin).partnerInvitation.approve({ id }), (e: any) => e.code === 'SERVICE_UNAVAILABLE');
    await assert.rejects(caller().partnerInvitation.submit(valid('rollback-new@fixture.invalid')), (e: any) => e.code === 'SERVICE_UNAVAILABLE');
    await waitForPartnerInvitationMailDispatchesForTests();
    assert.equal((await appRow('historical@fixture.invalid')).status, 'pending'); assert.equal(await count('partners'), 1);
    assert.equal(await count('partner_invitation_applications'), 1); assert.equal(await count('partner_invitation_mail_events'), 0); assert.equal(events.length, 0);
  } finally { await pool.query('DROP TRIGGER invitation_mail_fixture_fail ON partner_invitation_mail_events; DROP FUNCTION invitation_mail_fixture_fail()'); }
});

test('mail: duplicate email, recovery-key conflict and existing partner create no additional mail or global retry', async () => {
  const events = captureMails(); const input = valid(); await submitAndId(input); await waitForPartnerInvitationMailDispatchesForTests();
  const dormant = await dormantEvent();
  for (const other of [input, { ...input, registrationKey: randomUUID() }, { ...input, email: 'recovery-conflict@fixture.invalid' }, valid(' EXISTING@fixture.invalid ')]) {
    await caller().partnerInvitation.submit(other);
  }
  await assert.rejects(caller().partnerInvitation.submit({ ...valid(), website: 'bot' } as any));
  await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(events.length, 1); assert.equal((await mailRows()).length, 2); assert.equal((await mailRow(dormant)).state, 'new');
  assert.equal(await count('partner_invitation_applications'), 2);
});

test('mail: racing same-applicant registrations deliver exactly one event and one acknowledgement', async () => {
  const events = captureMails(); const input = valid();
  await Promise.all(Array.from({ length: 6 }, (_, i) => caller(null, `same-race-${i}`).partnerInvitation.submit(i % 2 ? { ...input, registrationKey: randomUUID() } : input)));
  await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(await count('partner_invitation_applications'), 1); assert.equal((await mailRows()).length, 1); assert.equal(events.length, 1);
  assertTerminal((await mailRows())[0], 'sent', null);
});

test('mail: racing DIFFERENT registrations dispatch every exact event, never bulk-claim and skip other applicants', async () => {
  const events = captureMails(); const dormant = await dormantEvent(); const connect = pool.connect.bind(pool);
  let arrived = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const timer = setTimeout(release, 1500);
  // Hold dispatch claims until both business transactions have committed. This
  // deterministically exposes the former UPDATE-all/rows[0]-only delivery bug.
  const intercept = mock.method(pool, 'connect', (callback?: any) => {
    if (typeof callback === 'function') return connect(callback);
    return connect().then((client: any) => ({ release: () => client.release(), query: async (sql: string, params?: any[]) => {
      if (/UPDATE partner_invitation_mail_events SET state='claimed'/.test(sql)) { arrived++; if (arrived === 2) release(); await gate; }
      return client.query(sql, params);
    } }));
  });
  try {
    const inputs = [valid('race-first@fixture.invalid'), valid('race-second@fixture.invalid')];
    await Promise.all(inputs.map((input, i) => caller(null, `distinct-race-${i}`).partnerInvitation.submit(input)));
    await waitForPartnerInvitationMailDispatchesForTests();
    assert.equal(arrived, 2); assert.equal(events.length, 2); assert.equal(new Set(events.map(e => e.id)).size, 2);
    assert.deepEqual(events.map(e => e.recipientEmail).sort(), inputs.map(i => i.email).sort());
    const rows = await mailRows(); assert.equal(rows.filter((r: any) => r.state === 'sent').length, 2);
    assert.equal((await mailRow(dormant)).state, 'new'); assert.equal((await mailRow(dormant)).attempts, 0);
  } finally { release(); clearTimeout(timer); await waitForPartnerInvitationMailDispatchesForTests(); intercept.mock.restore(); }
});

test('mail: concurrent/repeated approvals send one approval per applicant and never resend acknowledgement', async () => {
  const events = captureMails(); const ids = await Promise.all([submitAndId(valid('approve-one@fixture.invalid')), submitAndId(valid('approve-two@fixture.invalid'))]);
  await waitForPartnerInvitationMailDispatchesForTests();
  await Promise.all(ids.flatMap(id => Array.from({ length: 4 }, () => caller(admin).partnerInvitation.approve({ id }))));
  await Promise.all(ids.map(id => caller(admin).partnerInvitation.approve({ id }))); await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(events.length, 4); assert.equal((await mailRows()).length, 4);
  for (const id of ids) assert.deepEqual(events.filter(e => e.applicationId === id).map(e => e.kind).sort(), ['approval', 'registration_acknowledgement']);
});

test('mail: recipient names are HTML-escaped in both templates, with no credential/company/bank values', async () => {
  const events = captureMails(); const input = { ...valid(), name: `<b>&\"' Synthetic`, company: 'DE89370400440532013000 SECRET_BANK_HOLDER' };
  const id = await submitAndId(input); await waitForPartnerInvitationMailDispatchesForTests();
  await caller(admin).partnerInvitation.approve({ id }); await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal(events.length, 2);
  for (const event of events) {
    assert(event.htmlBody.includes('&lt;b&gt;&amp;&quot;&#39;')); assert(!event.htmlBody.includes(`<b>&\"'`));
    const payload = JSON.stringify(event);
    for (const secret of [input.password, input.registrationKey, input.company, 'DE89370400440532013000', 'SECRET_BANK_HOLDER', (await appRow()).password_hash]) assert(!payload.includes(secret));
    assert(!Object.keys(event).some(key => /bcc|password|iban|bic|credential/i.test(key)));
  }
});

test('mail: enqueue returns only a newly inserted event ID; rollback and duplicate enqueue preserve the ledger', async () => {
  const events = captureMails(); const id = await historicalApplication(); const input = { id, name: 'Synthetic', email: 'historical@fixture.invalid' };
  const client = await pool.connect();
  try { await client.query('BEGIN'); const eventId = await enqueuePartnerInvitationMail(client, input, 'registration_acknowledgement'); assert.equal(typeof eventId, 'number'); await client.query('ROLLBACK'); }
  finally { client.release(); }
  assert.equal((await mailRows()).length, 0);
  const eventId = await enqueuePartnerInvitationMail(pool, input, 'registration_acknowledgement'); assert.equal(typeof eventId, 'number');
  assert.equal(await enqueuePartnerInvitationMail(pool, { ...input, name: 'Replacement' }, 'registration_acknowledgement'), null);
  assert.equal((await mailRows()).length, 1); assert.equal((await mailRow(eventId!)).recipient_name, input.name); assert.equal(events.length, 0);
});

test('mail: invalid IDs never bulk-select, exact dispatch claims only its event, terminal/claimed states never retry', async () => {
  const events = captureMails(); const first = await dormantEvent(valid('exact-first@fixture.invalid')); const second = await dormantEvent(valid('exact-second@fixture.invalid'));
  for (const id of [undefined, null, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', 999999]) await dispatchPartnerInvitationMailEvent(id as number);
  assert.equal(events.length, 0); assert((await mailRows()).every((r: any) => r.state === 'new' && r.attempts === 0));
  await Promise.all(Array.from({ length: 5 }, () => dispatchPartnerInvitationMailEvent(second)));
  assert.equal(events.length, 1); assert.equal(Number(events[0].id), second); assert.equal((await mailRow(first)).state, 'new');
  for (const state of ['claimed', 'sent', 'unknown', 'failed']) {
    await pool.query('UPDATE partner_invitation_mail_events SET state=$2,attempts=1 WHERE id=$1', [first, state]);
    await Promise.all([dispatchPartnerInvitationMailEvent(first), dispatchPartnerInvitationMailEvent(first), dispatchPartnerInvitationMailEvent(second)]);
    assert.equal(events.length, 1); assert.equal((await mailRow(first)).state, state);
  }
});

test('mail: postcommit dispatch sees committed application/partner, and held transport never blocks business', { timeout: 5000 }, async () => {
  ENV.resendApiKey = 'synthetic-mail-key-never-live';
  const observations: any[] = []; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  setPartnerInvitationMailTransportForTests(async event => {
    const application = (await pool.query('SELECT status,linked_partner_id FROM partner_invitation_applications WHERE id=$1', [event.applicationId])).rows[0];
    assert(application); const partner = application.linked_partner_id ? (await pool.query('SELECT code,partner_number FROM partners WHERE id=$1', [application.linked_partner_id])).rows[0] : null;
    if (event.kind === 'approval') { assert.equal(application.status, 'approved'); assert.equal(partner.code, event.partnerCode); assert.equal(partner.partner_number, event.partnerNumber); }
    observations.push({ kind: event.kind, status: application.status }); await held; return { ok: true, providerId: `fixture-${event.id}` };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const business = (async () => { const id = await submitAndId(); const result = await caller(admin).partnerInvitation.approve({ id }); assert.equal(result.status, 'approved'); })();
    await Promise.race([business, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('MAIL_BLOCKED_BUSINESS')), 1500); })]);
    assert.equal((await appRow()).status, 'approved');
  } finally { if (timer) clearTimeout(timer); release(); await waitForPartnerInvitationMailDispatchesForTests(); }
  assert.equal(observations.length, 2); assert(observations.some(o => o.kind === 'approval' && o.status === 'approved'));
});

test('mail: test transport injection and drain are unavailable outside NODE_ENV=test', async () => {
  const nodeEnv = process.env.NODE_ENV;
  try { process.env.NODE_ENV = 'production'; assert.throws(() => setPartnerInvitationMailTransportForTests(async () => ({ ok: true })), /unavailable/); await assert.rejects(waitForPartnerInvitationMailDispatchesForTests(), /unavailable/); }
  finally { process.env.NODE_ENV = nodeEnv; setPartnerInvitationMailTransportForTests(); }
});

test('mail: actual provider payload/headers use event ID plus kind, no BCC/bank/credentials and exact recipients', async () => {
  const requests: { url: string; headers: Headers; body: any }[] = []; await dormantEvent();
  await pool.query("SELECT setval(pg_get_serial_sequence('partner_invitation_mail_events','id'), 1000, false)");
  await withProviderFetch((async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: `provider-${requests.length}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch, async () => {
    const input = { ...valid('payload@fixture.invalid'), company: 'DE89370400440532013000 SECRET_BANK_HOLDER' }; const id = await submitAndId(input);
    await waitForPartnerInvitationMailDispatchesForTests(); await caller(admin).partnerInvitation.approve({ id }); await waitForPartnerInvitationMailDispatchesForTests();
    const rows = (await mailRows()).filter((r: any) => r.application_id === id); assert.equal(requests.length, 2);
    assert.notEqual(Number(rows[0].id), id); // Prevent application-ID-only keys from passing by coincidence.
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i]; const row = rows[i];
      assert.equal(request.url, 'https://api.resend.com/emails'); assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-mail-key-never-live');
      assert.equal(request.headers.get('Content-Type'), 'application/json'); assert.equal(request.headers.get('Idempotency-Key'), `partner-invitation/${row.kind}/${row.id}`);
      assert.deepEqual(Object.keys(request.body).sort(), ['from', 'reply_to', 'to', 'subject', 'text', 'html'].sort());
      assert.deepEqual(request.body.to, [input.email]); assert.equal(request.body.from, '369 Research · Partner-Support <partnersupport@369research.eu>'); assert.equal(request.body.reply_to, 'partnersupport@369research.eu');
      for (const secret of [input.password, input.registrationKey, input.company, 'DE89370400440532013000', (await appRow(input.email)).password_hash]) assert(!JSON.stringify(request.body).includes(secret));
      assertTerminal(row, 'sent', null); assert.equal(row.provider_id, `provider-${i + 1}`);
      await dispatchPartnerInvitationMailEvent(Number(row.id));
    }
    assert.equal(requests.length, 2); assert.equal((await mailRows())[0].state, 'new');
  });
});

test('mail: missing runtime key is a terminal safe failure and adding a key/duplicate submit never retries it', async () => {
  const input = valid(); const id = await submitAndId(input); await waitForPartnerInvitationMailDispatchesForTests();
  const row = (await mailRows())[0]; assertTerminal(row, 'failed', 'missing_runtime_key');
  const events = captureMails(); await caller().partnerInvitation.mailReady(); await caller().partnerInvitation.submit(input); await dispatchPartnerInvitationMailEvent(Number(row.id));
  await waitForPartnerInvitationMailDispatchesForTests(); assert.equal(events.length, 0); assert.equal((await appRow()).status, 'pending');
  await caller(admin).partnerInvitation.approve({ id }); await waitForPartnerInvitationMailDispatchesForTests();
  assert.deepEqual(events.map(e => e.kind), ['approval']); assert.equal((await mailRow(Number(row.id))).state, 'failed');
});

test('mail: HTTP 4xx fails safely, HTTP 5xx stays unknown, neither blocks approval nor retries', async () => {
  for (const status of [422, 503]) {
    let calls = 0;
    await withProviderFetch((async () => { calls++; return new Response(JSON.stringify({ message: 'SENSITIVE_PROVIDER_DETAIL' }), { status }); }) as typeof fetch, async () => {
      const input = valid(`http-${status}@fixture.invalid`); const id = await submitAndId(input); await waitForPartnerInvitationMailDispatchesForTests();
      const approved = await caller(admin).partnerInvitation.approve({ id }); assert.equal(approved.status, 'approved'); await waitForPartnerInvitationMailDispatchesForTests();
      const rows = (await mailRows()).filter((r: any) => r.application_id === id); assert.equal(rows.length, 2);
      for (const row of rows) { assertTerminal(row, status >= 500 ? 'unknown' : 'failed', `http_${status}`); assert(!JSON.stringify(row).includes('SENSITIVE_PROVIDER_DETAIL')); await dispatchPartnerInvitationMailEvent(Number(row.id)); }
      await caller().partnerInvitation.submit(input); await caller(admin).partnerInvitation.approve({ id }); await waitForPartnerInvitationMailDispatchesForTests(); assert.equal(calls, 2);
    });
  }
});

test('mail: malformed 2xx or missing/invalid provider ID becomes unknown, never sent or retried', async () => {
  const bodies = ['not-json', '{}', '{"id":""}', '{"id":123}'];
  for (let i = 0; i < bodies.length; i++) {
    let calls = 0;
    await withProviderFetch((async () => { calls++; return new Response(bodies[i], { status: 200 }); }) as typeof fetch, async () => {
      const input = valid(`malformed-${i}@fixture.invalid`); await caller().partnerInvitation.submit(input); await waitForPartnerInvitationMailDispatchesForTests();
      const row = (await mailRows()).find((r: any) => r.recipient_email === input.email); assertTerminal(row, 'unknown', 'invalid_provider_response');
      await dispatchPartnerInvitationMailEvent(Number(row.id)); await caller().partnerInvitation.submit(input); await waitForPartnerInvitationMailDispatchesForTests(); assert.equal(calls, 1);
    });
  }
});

test('mail: fast mocked timeout/network throw and injected throw are unknown, nonblocking and never resubmitted', async () => {
  for (const name of ['AbortError', 'Error']) {
    let calls = 0;
    await withProviderFetch((async () => { calls++; const error = Error('SENSITIVE_NETWORK_DETAIL'); error.name = name; throw error; }) as typeof fetch, async () => {
      const input = valid(`throw-${name.toLowerCase()}@fixture.invalid`); const id = await submitAndId(input); await waitForPartnerInvitationMailDispatchesForTests();
      assert.equal((await caller(admin).partnerInvitation.approve({ id })).status, 'approved'); await waitForPartnerInvitationMailDispatchesForTests();
      for (const row of (await mailRows()).filter((r: any) => r.application_id === id)) { assertTerminal(row, 'unknown', name === 'AbortError' ? 'timeout' : 'network_error'); assert(!JSON.stringify(row).includes('SENSITIVE_NETWORK_DETAIL')); await dispatchPartnerInvitationMailEvent(Number(row.id)); }
      assert.equal(calls, 2);
    });
  }
  let calls = 0; setPartnerInvitationMailTransportForTests(async () => { calls++; throw Error('SENSITIVE_INJECTED_DETAIL'); });
  const id = await submitAndId(valid('injected-throw@fixture.invalid')); await waitForPartnerInvitationMailDispatchesForTests();
  assert.equal((await caller(admin).partnerInvitation.approve({ id })).status, 'approved'); await waitForPartnerInvitationMailDispatchesForTests();
  for (const row of (await mailRows()).filter((r: any) => r.application_id === id)) { assertTerminal(row, 'unknown', 'transport_error'); await dispatchPartnerInvitationMailEvent(Number(row.id)); }
  assert.equal(calls, 2); assert.equal(externalCalls, 0);
});
