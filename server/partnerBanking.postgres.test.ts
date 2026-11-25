import assert from 'node:assert/strict';
import test, { before, after, beforeEach, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import bcrypt from 'bcryptjs';
import { ENV } from './env.js';
import { getPool, getDb, closeDb } from './db.js';
import { router } from './trpc.js';
import { partnerBankingRouter } from './partnerBankingRouter.js';
import { partnerRouter } from './partnerRouter.js';
import { partnerInvitationRouter } from './partnerInvitationRouter.js';
import { shopSettingsRouter } from './shopSettingsRouter.js';
import { ensurePartnerBankingSchema } from './partnerBankingSchema.js';
import { ensureAccountSecuritySchema, isAccountSecuritySchemaReady } from './accountSecuritySchema.js';
import { ensurePartnerInvitationSchema } from './partnerInvitationSchema.js';
import { createPartnerToken, PARTNER_COOKIE_NAME, getAuthenticatedPartnerFromRequest } from './partnerAuth.js';
import { authDigest } from './accountSecurityService.js';
import { bankingOperation, saveOwnPartnerBankAccount } from './partnerBankingService.js';
import { orders } from '../drizzle/schema.js';

const socket = process.env.PARTNER_BANKING_TEST_PG_SOCKET;
if (!socket?.startsWith('/tmp/369-partner-banking.') || !socket.endsWith('/socket') || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL || process.env.DOTENV_CONFIG_PATH !== '/dev/null' || process.env.PARTNER_BANKING_TEST_SANITIZED !== '1') throw Error('DEDICATED_BANKING_UNIX_FIXTURE_REQUIRED');
let pool: any, db: any, externalCalls = 0, hash = '', readinessFailures = 0;
const logs: string[] = [];
const key = 'synthetic-local-banking-jwt-only-never-live';
const password = 'Synthetic-password-123';
const admin = { id: 1, username: 'synthetic_admin', role: 'admin', name: null, email: null };
const empty = { version: 0, updatedAt: null, bankAccount: null };
const valid = () => ({ accountHolder: 'Synthetic Holder', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', version: 0, currentPassword: password });
const app = router({ partnerBanking: partnerBankingRouter, partner: partnerRouter, partnerInvitation: partnerInvitationRouter, shopSettings: shopSettingsRouter });
function context(options: { partnerId?: number; user?: any; version?: number; ip?: string; headers?: any; method?: string } = {}) {
  const headers = options.headers ?? (options.partnerId ? { authorization: `Bearer ${createPartnerToken(options.partnerId, options.version ?? 0)}` } : {});
  const values: Record<string, string> = {};
  const ip = options.ip ?? 'local-banking-fixture-peer';
  return { req: { headers, method: options.method ?? 'POST', ip, socket: { remoteAddress: ip } }, res: { setHeader(name: string, value: string) { values[name.toLowerCase()] = value; } }, user: options.user ?? null, cacheHeaders: values } as any;
}
const caller = (options: Parameters<typeof context>[0] = {}) => app.createCaller(context(options));
const bankRow = async (id = 1) => (await pool.query('SELECT * FROM partner_bank_accounts WHERE partner_id=$1', [id])).rows[0];
const events = async () => (await pool.query('SELECT * FROM partner_bank_account_events ORDER BY id')).rows;
const failCode = (code: string) => (error: any) => { assert.equal(error.code, code); return true; };
async function baseline() {
  const result: Record<string, unknown> = {};
  for (const table of ['partners', 'partner_programs', 'partner_codes', 'partner_transactions', 'partner_code_usage', 'orders', 'order_items', 'articles', 'shop_settings', 'kwk_accounts', 'kwk_ledger']) {
    result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${['partner_programs', 'shop_settings'].includes(table) ? 'key' : 'id'}`)).rows;
  }
  return result;
}
before(async () => {
  const fail = () => { externalCalls++; throw Error('NONFIXTURE_NETWORK_FORBIDDEN'); };
  mock.method(globalThis, 'fetch', fail as any);
  mock.method(http, 'request', fail as any); mock.method(http, 'get', fail as any);
  mock.method(https, 'request', fail as any); mock.method(https, 'get', fail as any);
  const connect = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const first = args[0]; const options = Array.isArray(first) ? first[0] : first;
    const path = typeof options === 'string' ? options : options?.path;
    if (typeof path !== 'string' || path !== `${socket}/.s.PGSQL.55466`) return fail();
    return (connect as any).apply(this, args);
  });
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) mock.method(console, method, (...args: any[]) => { logs.push(args.map(v => String(v)).join(' ')); });
  await closeDb();
  ENV.databaseUrl = `postgresql://banking_local@localhost:55466/postgres?host=${encodeURIComponent(socket!)}`;
  ENV.resendApiKey = ''; ENV.bunqApiKey = ''; ENV.forgeApiKey = ''; ENV.dhlApiKey = ''; ENV.dhlTrackingApiKey = '';
  pool = await getPool(); db = await getDb();
  const connection = mock.method(pool, 'connect', async () => { throw Error('sensitive-fixture-schema-key-password-holder'); });
  try {
    for (let i = 0; i < 2; i++) {
      await assert.rejects(caller().partnerBanking.ready(), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && e.cause === undefined && !e.message.includes('sensitive'));
      readinessFailures++;
    }
    assert.equal((await caller().partnerInvitation.info()).enabled, true);
  } finally { connection.mock.restore(); }
  await ensurePartnerBankingSchema(); await ensurePartnerBankingSchema();
  // Bank namespace did not run existing account-security migration/ALTERs.
  assert.equal(isAccountSecuritySchemaReady(), false);
  await ensureAccountSecuritySchema(); await ensurePartnerInvitationSchema();
  hash = await bcrypt.hash(password, 4);
});
beforeEach(async () => {
  process.env.JWT_SECRET = key; delete process.env.PARTNER_BANK_DATA_KEY;
  await pool.query(`TRUNCATE partner_bank_accounts, partner_bank_account_events, partners, partner_programs, partner_codes,
    partner_transactions, partner_code_usage, orders, order_items, articles, shop_settings, kwk_accounts, kwk_ledger,
    account_auth_rate_limits, partner_invitation_applications RESTART IDENTITY CASCADE;
    INSERT INTO partner_programs(key,label,customer_discount_policy,commission_policy,settlement_method,allow_self_order_credit,active)
      VALUES('partner','Partner','first_paid_code_use','first_paid_code_order','shop_credit',true,true),
        ('creator','Creator','each_valid_code_use','each_paid_code_order','payout',false,true);
    INSERT INTO articles(sku,name,stock,is_active) VALUES('FIXTURE','Untouched stock',10,1);
    INSERT INTO shop_settings(key,value) VALUES('shop_open','true'),('bank_transfer_payment_instructions','{"enabled":false,"accounts":[]}');`);
  for (const id of [1,2]) await pool.query(`INSERT INTO partners(id,name,email,phone,company,code,partner_number,program_key,
    commission_type,commission_percent,customer_discount_percent,credit_balance,password_hash,notes,street,house_number,zip,city,country)
    VALUES($1,$2,$3,'unchanged','Fixture GmbH',$4,$5,'partner','dauerhaft',7,3,12.34,$6,'Untouched notes','Local','1','00000','Local','DE')`, [id, `Synthetic Partner ${id}`, `partner-${id}@fixture.invalid`, `LOCAL${id}`, `LOCAL-${id}`, hash]);
  await db.insert(orders).values({ orderId: 'UNCHANGED-ORDER', firstName: 'Synthetic', lastName: 'Owner', email: 'owner@fixture.invalid', phone: '', street: 'Local', houseNumber: '1', zip: '00000', city: 'Local', country: 'DE', subtotal: '100', discount: '10', shipping: '5', shippingCountry: 'DE', total: '95', paymentMethod: 'SEPA', status: 'offen', orderDate: new Date('2026-11-01T00:00:00Z') });
});
after(async () => {
  assert.equal(externalCalls, 0);
  const text = logs.join('\n');
  for (const secret of [valid().iban, valid().accountHolder, valid().bic, password, key, hash, 'sensitive-fixture']) assert(!text.includes(secret), 'Sensitive content must never enter logs');
  await closeDb(); ENV.databaseUrl = ''; mock.restoreAll();
});

test('readiness DB/DDL failure is generic, lazy, isolated and retryable; bank does not migrate existing account tables', () => { assert.equal(readinessFailures, 2); });
test('exact router contracts expose GET queries and save POST mutation, never admin write', async () => {
  const procedures = app._def.procedures as any;
  assert.equal(procedures['partnerBanking.mine']._def.type, 'query'); assert.equal(procedures['partnerBanking.adminGet']._def.type, 'query'); assert.equal(procedures['partnerBanking.save']._def.type, 'mutation');
  assert.equal(procedures['partnerBanking.ready']._def.type, 'query');
  assert.deepEqual(Object.keys(procedures).filter(path => path.startsWith('partnerBanking.')).sort(), ['partnerBanking.adminGet', 'partnerBanking.mine', 'partnerBanking.ready', 'partnerBanking.save']);
  assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.mine(), empty);
  assert.deepEqual(await caller({ user: admin }).partnerBanking.adminGet({ partnerId: 1 }), empty);
});
test('public ready is key/schema-only, returns no PII, never reads/writes business rows and fails closed on missing key', async () => {
  await caller({ partnerId: 1 }).partnerBanking.save(valid());
  const before = await baseline(); const bankBefore = await bankRow(); const auditBefore = await events();
  const query = mock.method(pool, 'query', async () => { throw Error('READY_MUST_NOT_QUERY_BUSINESS_ROWS'); });
  const connect = mock.method(pool, 'connect', async () => { throw Error('READY_MUST_NOT_CONNECT_AFTER_SCHEMA_READY'); });
  try {
    const ctx = context({ method: 'GET' });
    assert.deepEqual(await app.createCaller(ctx).partnerBanking.ready(), { ready: true });
    assert.equal(ctx.cacheHeaders['cache-control'], 'private, no-store');
    assert.equal(query.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0);
    delete process.env.JWT_SECRET;
    await assert.rejects(caller().partnerBanking.ready(), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && e.cause === undefined && !e.message.includes('KEY'));
    process.env.JWT_SECRET = key;
    await assert.rejects((caller().partnerBanking.ready as any)({ partnerId: 1 }), failCode('BAD_REQUEST'));
    assert.equal(query.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0);
  } finally { query.mock.restore(); connect.mock.restore(); process.env.JWT_SECRET = key; }
  assert.deepEqual(await baseline(), before); assert.deepEqual(await bankRow(), bankBefore); assert.deepEqual(await events(), auditBefore);
});
test('public/WaWi credentials alone cannot read/save own partner bank; only exact admin can adminGet', async () => {
  for (const user of [undefined, admin, { ...admin, id: 2, role: 'product_manager' }, { ...admin, role: 'packing' }, { ...admin, role: 'user' }]) {
    await assert.rejects(caller({ user }).partnerBanking.mine(), failCode('UNAUTHORIZED'));
    await assert.rejects(caller({ user }).partnerBanking.save(valid()), failCode('UNAUTHORIZED'));
  }
  for (const user of [undefined, { ...admin, id: 2, role: 'product_manager' }, { ...admin, role: 'packing' }, { ...admin, role: 'user' }]) await assert.rejects(caller({ user }).partnerBanking.adminGet({ partnerId: 1 }), (e: any) => ['FORBIDDEN','UNAUTHORIZED'].includes(e.code));
  await assert.rejects(caller({ partnerId: 1 }).partnerBanking.adminGet({ partnerId: 2 }), failCode('UNAUTHORIZED'));
  await assert.rejects(caller({ user: admin }).partnerBanking.adminGet({ partnerId: 999999 }), failCode('NOT_FOUND'));
});
test('save normalizes and returns exact snapshot, at-rest ciphertext and metadata-only audit', async () => {
  const input = { ...valid(), accountHolder: ' Synthetic Holder ', iban: ' de89 3704 0044 0532 0130 00 ', bic: ' cobadeffxxx ' };
  const saved = await caller({ partnerId: 1 }).partnerBanking.save(input);
  assert.equal(saved.version, 1); assert.match(saved.updatedAt!, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(saved.bankAccount, { accountHolder: valid().accountHolder, iban: valid().iban, bic: valid().bic });
  assert.deepEqual(Object.keys(saved).sort(), ['bankAccount','updatedAt','version']);
  assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.mine(), saved);
  assert.deepEqual(await caller({ user: admin }).partnerBanking.adminGet({ partnerId: 1 }), saved);
  const row = await bankRow(); assert.equal(row.version, 1); assert.match(row.encrypted_payload, /^v1\./);
  assert.deepEqual(Object.keys(row).sort(), ['created_at','encrypted_payload','partner_id','updated_at','version']);
  const audit = await events(); assert.equal(audit.length, 1); assert.equal(audit[0].actor_partner_id, 1); assert.equal(audit[0].version, 1); assert.equal(audit[0].event, 'bank_account_saved');
  for (const secret of [valid().iban, valid().accountHolder, valid().bic, password, key]) { assert(!JSON.stringify(row).includes(secret)); assert(!JSON.stringify(audit).includes(secret)); }
});
test('missing/blank BIC stored null and same-content current/retry versions do not change timestamp/IV/audit', async () => {
  const input = { ...valid(), bic: '' }; const first = await caller({ partnerId: 1 }).partnerBanking.save(input); assert.equal(first.bankAccount!.bic, null);
  const before = await bankRow();
  assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.save(input), first);
  assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.save({ ...input, bic: undefined, version: 1 }), first);
  assert.deepEqual(await bankRow(), before); assert.equal((await events()).length, 1);
});
test('password required and wrong password cannot create/update/no-change-retry; attempts retained outside rollback', async () => {
  await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), currentPassword: 'Wrong-password' }), failCode('BAD_REQUEST'));
  assert.equal(await bankRow(), undefined);
  const first = await caller({ partnerId: 1 }).partnerBanking.save(valid());
  for (const patch of [{ version: 1 }, { version: 1, accountHolder: 'Changed Holder' }, {}]) await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), ...patch, currentPassword: 'Wrong-password' }), failCode('BAD_REQUEST'));
  assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.mine(), first); assert.equal((await events()).length, 1);
  const rates = (await pool.query('SELECT attempts FROM account_auth_rate_limits')).rows; assert(rates.every((r: any) => r.attempts === 5));
});
test('strict actual route rejects crosspartner ownership and input values without secrets in Zod causes', async () => {
  for (const patch of [{ partnerId: 2 }, { version: -1 }, { version: 1.5 }, { currentPassword: '' }, { iban: 'DE89370400440532013001' }, { bic: 'BAD-BIC' }, { accountHolder: 'Bad\nHolder' }, { [password]: valid().iban }]) {
    await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), ...patch } as any), (e: any) => {
      assert.equal(e.code, 'BAD_REQUEST');
      // tRPC wraps custom parser errors once; both levels contain only our
      // generic message, never a ZodError or raw received input/unknown keys.
      const errorText = e.message + (e.cause?.message ?? '') + JSON.stringify(e.cause ?? null);
      for (const secret of [password, valid().iban, valid().accountHolder]) assert(!errorText.includes(secret)); return true;
    });
  }
  for (const input of [{}, { partnerId: 2 }, null]) await assert.rejects((caller({ partnerId: 1 }).partnerBanking.mine as any)(input), failCode('BAD_REQUEST'));
  await assert.rejects(caller({ user: admin }).partnerBanking.adminGet({ partnerId: 2, bankAccount: valid() } as any), failCode('BAD_REQUEST'));
  assert.equal(await bankRow(), undefined); assert.equal((await pool.query('SELECT count(*) AS n FROM account_auth_rate_limits')).rows[0].n, '0');
});
test('own scope reads/writes never accept other partner id; own passwords/cross-partner bearer cannot cross', async () => {
  const first = await caller({ partnerId: 1 }).partnerBanking.save(valid());
  assert.deepEqual(await caller({ partnerId: 2 }).partnerBanking.mine(), empty);
  const second = await caller({ partnerId: 2 }).partnerBanking.save({ ...valid(), accountHolder: 'Other Holder' });
  assert.equal(second.bankAccount!.accountHolder, 'Other Holder'); assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.mine(), first);
  assert.deepEqual(await caller({ user: admin }).partnerBanking.adminGet({ partnerId: 2 }), second);
});
test('revoked session and inactive/deleted partners cannot read/write, admin still sees inactive bank', async () => {
  const first = await caller({ partnerId: 1 }).partnerBanking.save(valid());
  await pool.query('UPDATE partners SET session_version=1 WHERE id=1');
  for (const work of [() => caller({ partnerId: 1 }).partnerBanking.mine(), () => caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), version: 1 })]) await assert.rejects(work(), failCode('UNAUTHORIZED'));
  assert.deepEqual(await caller({ partnerId: 1, version: 1 }).partnerBanking.mine(), first);
  await pool.query('UPDATE partners SET is_active=0 WHERE id=1');
  await assert.rejects(caller({ partnerId: 1, version: 1 }).partnerBanking.mine(), failCode('UNAUTHORIZED'));
  await assert.rejects(caller({ partnerId: 1, version: 1 }).partnerBanking.save(valid()), failCode('UNAUTHORIZED'));
  assert.deepEqual(await caller({ user: admin }).partnerBanking.adminGet({ partnerId: 1 }), first);
  await pool.query('DELETE FROM partners WHERE id=2');
  await assert.rejects(caller({ partnerId: 2 }).partnerBanking.mine(), failCode('UNAUTHORIZED'));
});
test('invalid/forged bearer cannot fall back to ambient valid partner cookie', async () => {
  const cookie = `${PARTNER_COOKIE_NAME}=${createPartnerToken(1)}`;
  for (const token of ['invalid', createPartnerToken(99999), createPartnerToken(1, 9)]) {
    await assert.rejects(caller({ headers: { authorization: `Bearer ${token}`, cookie, origin: 'https://www.369research.eu' } }).partnerBanking.mine(), failCode('UNAUTHORIZED'));
  }
});
test('CSRF cookie-origin checks protect reads/writes; explicit bearer owns its scope despite other ambient cookie', async () => {
  const cookie = `${PARTNER_COOKIE_NAME}=${createPartnerToken(1)}`;
  for (const headers of [{ cookie }, { cookie, origin: 'https://evil.invalid' }, { cookie, origin: 'https://www.369research.eu.evil.invalid' }]) {
    await assert.rejects(caller({ headers }).partnerBanking.save(valid()), failCode('FORBIDDEN'));
    await assert.rejects(caller({ headers, method: 'GET' }).partnerBanking.mine(), failCode('FORBIDDEN'));
  }
  assert.deepEqual(await caller({ headers: { cookie, origin: 'https://www.369research.eu' } }).partnerBanking.mine(), empty);
  assert.deepEqual(await caller({ headers: { cookie, referer: 'https://www.369research.eu/partnerportal' }, method: 'GET' }).partnerBanking.mine(), empty);
  const bearer = caller({ headers: { authorization: `Bearer ${createPartnerToken(2)}`, cookie, origin: 'https://evil.invalid' } });
  await bearer.partnerBanking.save({ ...valid(), accountHolder: 'Bearer Own Holder' });
  assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.mine(), empty);
  assert.equal((await caller({ partnerId: 2 }).partnerBanking.mine()).bankAccount!.accountHolder, 'Bearer Own Holder');
});
test('private no-store headers apply to successful/invalid/unauthorized/PM-rejected bank responses', async () => {
  const cases = [context({ partnerId: 1 }), context(), context({ user: { ...admin, role: 'product_manager' } }), context({ partnerId: 1 })];
  const operations = [(c: any) => c.partnerBanking.mine(), (c: any) => c.partnerBanking.mine(), (c: any) => c.partnerBanking.adminGet({ partnerId: 1 }), (c: any) => c.partnerBanking.save({ ...valid(), iban: 'invalid' })];
  for (let i = 0; i < cases.length; i++) {
    await operations[i](app.createCaller(cases[i])).catch(() => {});
    assert.equal(cases[i].cacheHeaders['cache-control'], 'private, no-store'); assert.equal(cases[i].cacheHeaders.pragma, 'no-cache');
  }
});
test('optimistic concurrency permits only matching version changes and immediate equal retry; arbitrary stale/future conflicts', async () => {
  const one = await caller({ partnerId: 1 }).partnerBanking.save(valid());
  await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), accountHolder: 'Stale Holder' }), failCode('CONFLICT'));
  await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), version: 9 }), failCode('CONFLICT'));
  const twoInput = { ...valid(), version: 1, accountHolder: 'Version Two Holder' };
  const two = await caller({ partnerId: 1 }).partnerBanking.save(twoInput); assert.equal(two.version, 2);
  assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.save(twoInput), two);
  await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save({ ...twoInput, version: 0 }), failCode('CONFLICT'));
  await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), version: 1 }), failCode('CONFLICT'));
  assert.notEqual((await bankRow()).encrypted_payload, one.bankAccount); assert.equal((await events()).length, 2);
});
test('simultaneous different initial saves serialize parent row: one success, one CONFLICT, version remains 1', async () => {
  const results = await Promise.allSettled([caller({ partnerId: 1 }).partnerBanking.save(valid()), caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), accountHolder: 'Concurrent Other Holder' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'CONFLICT');
  assert.equal((await bankRow()).version, 1); assert.equal((await events()).length, 1);
});
test('simultaneous identical initial saves are safe idempotent retries with exactly one encrypted row/event', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => caller({ partnerId: 1 }).partnerBanking.save(valid())));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal((await bankRow()).version, 1); assert.equal((await events()).length, 1);
});
test('simultaneous version-1 updates cannot silently overwrite each other', async () => {
  await caller({ partnerId: 1 }).partnerBanking.save(valid());
  const results = await Promise.allSettled(['First Change', 'Second Change'].map(accountHolder => caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), version: 1, accountHolder })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'CONFLICT');
  assert.equal((await bankRow()).version, 2); assert.equal((await events()).length, 2);
});
test('transaction locks recheck password hash/session version/activity after authentication and before bcrypt/write', async () => {
  const ctx = context({ partnerId: 1 });
  for (const patch of ["password_hash='changed-fixture-hash'", 'session_version=1', 'is_active=0']) {
    const authenticated = await getAuthenticatedPartnerFromRequest(ctx.req); assert(authenticated);
    await pool.query(`UPDATE partners SET ${patch} WHERE id=1`);
    await assert.rejects(bankingOperation(() => saveOwnPartnerBankAccount(ctx.req, authenticated, valid())), failCode('UNAUTHORIZED'));
    assert.equal(await bankRow(), undefined);
    await pool.query('UPDATE partners SET password_hash=$1, session_version=0, is_active=1 WHERE id=1', [hash]);
  }
});
test('real concurrent deactivation queued before save lock causes locked active recheck to fail closed', async () => {
  const blocker = await pool.connect();
  await blocker.query('BEGIN'); await blocker.query('SELECT id FROM partners WHERE id=1 FOR UPDATE');
  const saving = caller({ partnerId: 1 }).partnerBanking.save(valid());
  // Wait until the bank transaction is actively waiting for the locked partner.
  let waiting = false;
  for (let i = 0; i < 100; i++) {
    const activity = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT is_active, password_hash, session_version FROM partners%'");
    if (activity.rows[0].n > 0) { waiting = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  try { assert(waiting); await blocker.query('UPDATE partners SET is_active=0 WHERE id=1'); await blocker.query('COMMIT'); }
  finally { await blocker.query('ROLLBACK'); blocker.release(); }
  await assert.rejects(saving, failCode('UNAUTHORIZED')); assert.equal(await bankRow(), undefined);
});
test('bank-specific identity rate limit is enforced before bcrypt and does not consume login buckets', async () => {
  const compare = mock.method(bcrypt, 'compare', async () => false); let calls = 0;
  const counted = mock.method(bcrypt, 'compare', async () => { calls++; return false; });
  try {
    for (let i = 0; i < 10; i++) await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save(valid()), failCode('BAD_REQUEST'));
    await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save(valid()), failCode('TOO_MANY_REQUESTS'));
    assert.equal(calls, 10);
    const rows = (await pool.query('SELECT * FROM account_auth_rate_limits')).rows;
    assert.equal(rows.length, 2); assert(rows.every((r: any) => /^[a-f0-9]{64}$/.test(r.bucket_hash)));
    assert.equal(rows.find((r: any) => r.bucket_hash === authDigest('rate', 'partner.banking.save:identity:1')).attempts, 11);
    assert(!rows.some((r: any) => r.bucket_hash === authDigest('rate', 'partner.login:identity:1')));
    for (const secret of [password, 'local-banking-fixture-peer', valid().iban]) assert(!JSON.stringify(rows).includes(secret));
  } finally { counted.mock.restore(); compare.mock.restore(); }
});
test('bank-specific IP rate limit uses actual peer despite spoofed forwarding, checks before bcrypt; limiter DB failure is closed', async () => {
  const ip = 'shared-fixture-peer';
  await pool.query('INSERT INTO account_auth_rate_limits(bucket_hash,attempts) VALUES($1,30)', [authDigest('rate', `partner.banking.save:ip:${ip}`)]);
  const compare = mock.method(bcrypt, 'compare', async () => { throw Error('BCRYPT_MUST_NOT_RUN'); });
  try {
    await assert.rejects(caller({ ip, headers: { authorization: `Bearer ${createPartnerToken(1)}`, 'x-forwarded-for': '198.51.100.45' } }).partnerBanking.save(valid()), failCode('TOO_MANY_REQUESTS'));
    assert.equal(compare.mock.callCount(), 0);
    const query = pool.query.bind(pool);
    const injected = mock.method(pool, 'query', async (sql: string, ...args: any[]) => {
      if (sql.includes('INSERT INTO account_auth_rate_limits')) throw Error('sensitive-fixture-iban-password');
      return query(sql, ...args);
    });
    try { await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save(valid()), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && e.cause === undefined); assert.equal(compare.mock.callCount(), 0); }
    finally { injected.mock.restore(); }
  } finally { compare.mock.restore(); }
  assert.equal(await bankRow(), undefined);
});
test('bank insert/audit failure rolls back all bank writes, metadata and version with generic retryable errors', async () => {
  await pool.query(`CREATE FUNCTION banking_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sensitive-fixture-holder-iban-password'; END $$;
    CREATE TRIGGER banking_fixture_fail BEFORE INSERT ON partner_bank_account_events FOR EACH ROW EXECUTE FUNCTION banking_fixture_fail()`);
  try {
    await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save(valid()), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && e.cause === undefined && !e.message.includes('sensitive'));
    assert.equal(await bankRow(), undefined); assert.equal((await events()).length, 0);
  } finally { await pool.query('DROP TRIGGER banking_fixture_fail ON partner_bank_account_events; DROP FUNCTION banking_fixture_fail()'); }
  const one = await caller({ partnerId: 1 }).partnerBanking.save(valid()); const before = await bankRow();
  await pool.query(`CREATE FUNCTION banking_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'sensitive-fixture-update'; END $$;
    CREATE TRIGGER banking_fixture_fail BEFORE UPDATE ON partner_bank_accounts FOR EACH ROW EXECUTE FUNCTION banking_fixture_fail()`);
  try {
    await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), version: 1, accountHolder: 'Changed Holder' }), failCode('SERVICE_UNAVAILABLE'));
    assert.deepEqual(await bankRow(), before); assert.equal((await events()).length, 1);
  } finally { await pool.query('DROP TRIGGER banking_fixture_fail ON partner_bank_accounts; DROP FUNCTION banking_fixture_fail()'); }
  assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.mine(), one);
  assert.equal((await caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), version: 1, accountHolder: 'Changed Holder' })).version, 2);
});
test('tag tamper/row swapping fail closed on own/admin reads and saves, never replacing corrupted ciphertext', async () => {
  await caller({ partnerId: 1 }).partnerBanking.save(valid());
  const row = await bankRow(); const parts = row.encrypted_payload.split('.');
  const tag = Buffer.from(parts[2], 'base64url'); tag[0] ^= 1; parts[2] = tag.toString('base64url');
  await pool.query('UPDATE partner_bank_accounts SET encrypted_payload=$1 WHERE partner_id=1', [parts.join('.')]);
  for (const work of [() => caller({ partnerId: 1 }).partnerBanking.mine(), () => caller({ user: admin }).partnerBanking.adminGet({ partnerId: 1 }), () => caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), version: 1 })]) await assert.rejects(work(), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && e.cause === undefined);
  assert.equal((await bankRow()).encrypted_payload, parts.join('.'));
  await pool.query('INSERT INTO partner_bank_accounts(partner_id,version,encrypted_payload) VALUES(2,1,$1)', [row.encrypted_payload]);
  await assert.rejects(caller({ partnerId: 2 }).partnerBanking.mine(), failCode('SERVICE_UNAVAILABLE'));
});
test('missing/weak/changed key failures affect only banking; unrelated shop and invitation remain usable', async () => {
  const shopBefore = await caller().shopSettings.getBankTransferPresentation(); const invitation = await caller().partnerInvitation.info();
  await caller({ partnerId: 1 }).partnerBanking.save(valid());
  const before = await bankRow();
  for (const secret of [undefined, 'short', 'dev-secret-change-me'.repeat(2), 'another-strong-local-synthetic-bank-secret']) {
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    for (const work of [() => caller({ partnerId: 1 }).partnerBanking.mine(), () => caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), version: 1 }), () => caller({ user: admin }).partnerBanking.adminGet({ partnerId: 1 })]) await assert.rejects(work(), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && e.cause === undefined);
    assert.deepEqual(await caller().shopSettings.getBankTransferPresentation(), shopBefore); assert.deepEqual(await caller().partnerInvitation.info(), invitation);
    assert.deepEqual(await bankRow(), before);
  }
  process.env.JWT_SECRET = key; assert.equal((await caller({ partnerId: 1 }).partnerBanking.mine()).version, 1);
});
test('bank DB read failure is generic/no-store, cannot block public shop presentation or invitation info/submission', async () => {
  const query = pool.query.bind(pool);
  const injected = mock.method(pool, 'query', async (sql: string, ...args: any[]) => {
    if (typeof sql === 'string' && sql.includes('LEFT JOIN partner_bank_accounts')) throw Error('sensitive-fixture-bank-data');
    return query(sql, ...args);
  });
  try {
    await assert.rejects(caller({ partnerId: 1 }).partnerBanking.mine(), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && e.cause === undefined);
    assert(await caller().shopSettings.getBankTransferPresentation()); assert.equal((await caller().partnerInvitation.info()).enabled, true);
    assert.deepEqual(await caller().partnerInvitation.submit({ registrationKey: randomUUID(), name: 'Synthetic Invitee', email: 'bank-failure@fixture.invalid', phone: '123', password, passwordConfirm: password, agreeToTerms: true, termsVersion: 'ben-10-10-v1', website: '' }), { status: 'pending' });
  } finally { injected.mock.restore(); }
  assert.deepEqual(await caller({ partnerId: 1 }).partnerBanking.mine(), empty);
});
test('bank save leaves existing partner profile/address/password/terms/payout balances/orders/stock/settings byte-for-byte unchanged', async () => {
  const before = await baseline();
  await caller({ partnerId: 1 }).partnerBanking.save(valid());
  await caller({ partnerId: 1 }).partnerBanking.save({ ...valid(), version: 1, accountHolder: 'Changed Holder' });
  await caller({ partnerId: 2 }).partnerBanking.save({ ...valid(), bic: '' });
  assert.deepEqual(await baseline(), before); assert.equal(externalCalls, 0);
});
test('existing portalMe/admin partner list and public shop/invitation never receive partner bank data', async () => {
  await caller({ partnerId: 1 }).partnerBanking.save(valid());
  const results = [await caller({ partnerId: 1 }).partner.portalMe(), await caller({ user: admin }).partner.list(), await caller().shopSettings.getBankTransferPresentation(), await caller().partnerInvitation.info()];
  for (const result of results) {
    const text = JSON.stringify(result);
    for (const secret of [valid().iban, valid().accountHolder, valid().bic, password, key]) assert(!text.includes(secret));
    assert(!text.includes('encrypted_payload')); assert(!text.includes('bankAccount'));
  }
});
test('bank tables cascade partner deletion, metadata never blocks existing delete path', async () => {
  await caller({ partnerId: 1 }).partnerBanking.save(valid());
  await pool.query('DELETE FROM partners WHERE id=1');
  assert.equal(await bankRow(), undefined); assert.equal((await events()).length, 0);
  await assert.rejects(caller({ user: admin }).partnerBanking.adminGet({ partnerId: 1 }), failCode('NOT_FOUND'));
});
test('bcrypt unexpected errors never escape with values/cause or log secrets, transaction rolls back', async () => {
  const compare = mock.method(bcrypt, 'compare', async () => { throw Error(`sensitive-fixture-${password}-${valid().iban}`); });
  try { await assert.rejects(caller({ partnerId: 1 }).partnerBanking.save(valid()), (e: any) => e.code === 'SERVICE_UNAVAILABLE' && e.cause === undefined && !e.message.includes(password)); }
  finally { compare.mock.restore(); }
  assert.equal(await bankRow(), undefined); assert.equal((await events()).length, 0);
});
