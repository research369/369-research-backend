import assert from 'node:assert/strict';
import test, { before, beforeEach, after, afterEach, mock } from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import express from 'express';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import pg from 'pg';
import superjson from 'superjson';
import { ENV } from './env.js';
import { getDb, getPool, closeDb } from './db.js';
import { router, type Context } from './trpc.js';
import { createOrderSchema, orderRouter } from './orderRouter.js';
import { createToken, getUserFromRequest } from './auth.js';
import { createPartnerToken } from './partnerAuth.js';
import { createKwkToken } from './kwkAuth.js';
import { syncKwkAccountCache } from './kwkService.js';
import { ensureGoodieSchema } from './goodieSchema.js';
import { ensureAdminChangeLogSchema } from './adminChangeLogService.js';
import { ensureCustomerOrderBlockSchema } from './customerOrderBlockService.js';
import { ensurePriorityOrderIntegritySchema, checkoutFingerprint } from './priorityOrderIntegrity.js';
import { ensureAccountSecuritySchema } from './accountSecuritySchema.js';
import { ensurePermissionsSchema } from './permissionsSchema.js';
import { ensurePartnerFinancialSchema } from './partnerFinancialSchema.js';
import { ensureCustomerDataChangeSchema } from './customerDataChangeService.js';
import { PRECISION_COMMERCE_HEADER, PRECISION_COMMERCE_POLICY, resolvePrecisionShopPrincipal, precisionReceiptFingerprint } from './precisionCommercePrincipal.js';
import { PRECISION_CARTRIDGE_FAMILIES, PRECISION_NASAL_FAMILIES } from './precisionCommercePolicy.js';
import { NASAL_DIY_SET_COMPONENTS } from './nasalDiySetConfig.js';

/** SOURCE INTEGRATION ONLY. Parent's runner creates fresh actual Drizzle PG in a
 * loopback-only network namespace. Never import index.ts, start PG, read a real
 * credential, use a provider, or substitute a mock router/database here. */
const LOCAL_DATABASE = 'postgresql://priority_local@127.0.0.1:56439/postgres';
const SYNTHETIC_GATEWAY_KEY = 'precision_http_synthetic_gateway_key_20261127_only';
const SYNTHETIC_JWT_KEY = 'precision_http_synthetic_jwt_key_20261127_only';
const UI_PUBLIC = fileURLToPath(new URL('../../commerce-ui-artifact/public/', import.meta.url));
const WORKSPACE = fileURLToPath(new URL('../../', import.meta.url));
const BROWSER_SCRIPT = fileURLToPath(new URL('../scripts/precision-checkout-browser.py', import.meta.url));
const require = createRequire(import.meta.url);
const { createPrecisionCommerceHandler, PROCEDURES } = require('../../frontend/netlify/lib/precisionCommerceGateway.cjs');
const nativeFetch = globalThis.fetch.bind(globalThis);
const allowedOrigins = new Set<string>();
const servers: Server[] = [];
let pool: any;
let backendOrigin = '', gatewayOrigin = '';
let external = 0, upstreamRequests = 0, readOnlyTransactions = 0, authorizedUpstreams = 0;
let loseNextCreateResponse = false;
let frontendIntent: any;
let savedPrecisionEnabled: string | undefined, savedGatewayKey: string | undefined;

// Independent expected product identities: tests must not derive their accepted
// inputs from the implementation whitelist. Prices below are TEST DATA, NOT PRICES
// from a real shop. Adamax=20 (+7 DIY), Selank=24, PT141=30, Retatrutide=40.
const EXPECTED_CARTRIDGES = ['3g-triple-g', 'tirzepatide', 'cagrilinitide', 'eloralintide', 'mots-c', 'ss-31', 'nad-plus', '5-amino-1mq', 'tb-500', 'ghk-cu', 'pt-141', 'tesamorelin', 'cjc-ipamorelin-kombi'];
const EXPECTED_NASAL = ['semax', 'selank', 'adamax', 'oxytocin', 'pt-141', 'kisspeptin-10', 'semax-selank'];
const ID = { adamax: 10001, selank: 10002, pt141: 10003, retatrutide: 10004, bpc: 10005, bac10: 10010, bac3: 10011 };
type FixtureArticle = { id: number; family: string; sku: string; name: string; price: number; dosage: string; category: string };
const fixtureArticles: FixtureArticle[] = [
  { id: ID.adamax, family: 'adamax', sku: 'SYNTHETIC-ADAMAX-10MG', name: 'Synthetic Adamax (10 mg)', price: 20, dosage: '10 mg', category: 'Peptide' },
  { id: ID.selank, family: 'selank', sku: 'SELANK-10MG', name: 'Synthetic Selank (10 mg)', price: 24, dosage: '10 mg', category: 'Peptide' },
  { id: ID.pt141, family: 'pt-141', sku: 'PT-141-10MG', name: 'Synthetic PT141 (10 mg)', price: 30, dosage: '10 mg', category: 'Peptide' },
  { id: ID.retatrutide, family: '3g-triple-g', sku: '3G-TRIPLE-G-10MG', name: 'Synthetic Retatrutide (10 mg)', price: 40, dosage: '10 mg', category: 'Peptide' },
  { id: ID.bpc, family: 'bpc-157', sku: 'BPC-157-5MG', name: 'Synthetic BPC (5 mg)', price: 10, dosage: '5 mg', category: 'Peptide' },
  { id: ID.bac10, family: 'bac-wasser', sku: 'BAC-10ML', name: 'Synthetic BAC Wasser (10 ml)', price: 5, dosage: '10 ml', category: 'Zubehör' },
  { id: ID.bac3, family: 'bac-wasser-3ml', sku: 'BAC-3ML', name: 'BAC Wasser 3ml', price: 4.16, dosage: '3 ml', category: 'Zubehör' },
];
for (const family of new Set([...EXPECTED_CARTRIDGES, ...EXPECTED_NASAL])) {
  if (!fixtureArticles.some(a => a.family === family)) fixtureArticles.push({ id: 10100 + fixtureArticles.length, family, sku: `${family.toUpperCase()}-10MG`, name: `Synthetic ${family} (10 mg)`, price: 20, dosage: '10 mg', category: 'Peptide' });
}
const CUSTOMER = { firstName: 'Synthetic', lastName: 'Owner', email: 'synthetic@example.test', phone: '+41790000000', street: 'Local', houseNumber: '1', zip: '8000', city: 'Local', country: 'CH' };
function article(family: string) { const a = fixtureArticles.find(a => a.family === family); assert.ok(a, family); return a; }
function line(family = 'adamax', extra: any = {}) { const a = article(family); return { name: a.name, dosage: a.dosage, shopProductId: a.family, price: a.price, quantity: 1, type: a.category === 'Peptide' ? 'peptide' : 'accessory', ...extra }; }
function kit(family = 'adamax', quantity = 1) { return line(family, { quantity, isNasalSpray: true, isNasalDiySet: true }); }
function input(extra: any = {}) { return {
  orderSource: 'shop', storeKey: '369research', sendOrderConfirmation: false,
  checkoutIdempotencyKey: 'a'.repeat(64), items: [kit()], customer: { ...CUSTOMER },
  subtotal: 0, discount: 0, discountCode: null, shipping: 18, shippingCountry: 'ch', total: 18,
  paymentMethod: 'SEPA', date: '2026-11-27', ...extra,
}; }
function clientFingerprint(payload: any): string { return createHash('sha256').update(frontendIntent.checkoutPayloadIntent(payload)).digest('hex'); }
function unwrap(wire: any): any { const data = wire?.result?.data; assert.ok(data && Object.hasOwn(data, 'json'), 'Actual superjson tRPC envelope required'); return superjson.deserialize(data); }
type HttpResult = { status: number; headers: Headers; wire: any; text: string; data?: any };
async function callAt(origin: string, procedure: string, payload: any, headers: Record<string, string> = {}, method = 'POST'): Promise<HttpResult> {
  const path = origin === backendOrigin ? '/api/trpc/' : '/api/precision-commerce/';
  const url = new URL(path + procedure, origin);
  if (method === 'GET') url.searchParams.set('input', JSON.stringify({ json: payload }));
  const response = await globalThis.fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify({ json: payload }) } : {}), redirect: 'error' });
  const text = await response.text(); const wire = JSON.parse(text);
  return { status: response.status, headers: response.headers, wire, text, ...(response.ok ? { data: unwrap(wire) } : {}) };
}
const gateway = (procedure: string, payload: any, headers: Record<string, string> = {}) => callAt(gatewayOrigin, procedure, payload, headers);
const backend = (procedure: string, payload: any, headers: Record<string, string> = {}, method = 'POST') => callAt(backendOrigin, procedure, payload, headers, method);
async function success(result: Promise<HttpResult>) { const r = await result; assert.equal(r.status, 200, r.text); assert.equal(r.wire.error, undefined); return r.data; }
async function denied(result: Promise<HttpResult>, message?: RegExp) { const r = await result; assert.ok(r.status >= 400, `Expected refusal, received ${r.status}`); assert.equal(r.wire.result, undefined); if (message) assert.match(r.text, message); return r; }
async function quote(payload: any, headers: Record<string, string> = {}) { return (await success(gateway('order.quote', payload, headers))).quote; }
async function create(payload: any, headers: Record<string, string> = {}) { const q = await quote(payload, headers); return success(gateway('order.create', { ...payload, expectedQuoteHash: q.hash }, headers)); }
function receiptInput(payload: any) { return { checkoutIdempotencyKey: payload.checkoutIdempotencyKey, payloadFingerprint: clientFingerprint(payload) }; }
const receipt = (payload: any) => success(gateway('order.checkoutReceipt', receiptInput(payload)));
async function count(table: string) { assert.match(table, /^[a-z_]+$/); return Number((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n); }
async function stock(id: number) { return Number((await pool.query('SELECT stock FROM articles WHERE id=$1', [id])).rows[0].stock); }
async function movements(orderId?: string) { return (await pool.query(`SELECT article_id, SUM(-quantity_change)::int used FROM stock_history ${orderId ? 'WHERE order_id=$1' : ''} GROUP BY article_id ORDER BY article_id`, orderId ? [orderId] : [])).rows; }
async function snapshot() {
  const state: Record<string, any> = {};
  for (const table of ['orders', 'order_items', 'customers', 'articles', 'stock_history', 'priority_checkout_receipts', 'promo_codes', 'kwk_ledger', 'kwk_accounts', 'partners', 'partner_transactions']) state[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
  return state;
}
async function noWrites() { assert.equal(await count('orders'), 0); assert.equal(await count('order_items'), 0); assert.equal(await count('priority_checkout_receipts'), 0); assert.equal(await count('stock_history'), 0); }
function noPii(r: HttpResult, orderId?: string) { for (const value of [CUSTOMER.email, CUSTOMER.phone, 'Synthetic Owner', ...(orderId ? [orderId] : [])]) assert.ok(!r.text.includes(value), `Refusal disclosed ownership/customer data`); }
async function listen(app: express.Express): Promise<string> {
  const server = createServer(app); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`; allowedOrigins.add(origin); return origin;
}

before(async () => {
  assert.equal(process.env.DATABASE_URL, '', 'Use parent isolated runner: never inherit a database URL');
  assert.equal(process.env.RAILWAY_DB_URL || '', '');
  assert.equal(process.env.PRECISION_TEST_ISOLATED, 'true', 'Parent must provide a loopback-only network namespace');
  assert.equal(ENV.databaseUrl, '');
  savedPrecisionEnabled = process.env.PRECISION_COMMERCE_ENABLED; savedGatewayKey = process.env.PRECISION_COMMERCE_GATEWAY_KEY;
  process.env.PRECISION_COMMERCE_ENABLED = 'true'; process.env.PRECISION_COMMERCE_GATEWAY_KEY = SYNTHETIC_GATEWAY_KEY;
  ENV.jwtSecret = SYNTHETIC_JWT_KEY;
  ENV.resendApiKey = ''; ENV.bunqApiKey = ''; ENV.dhlApiKey = ''; ENV.dhlTrackingApiKey = ''; ENV.forgeApiKey = ''; ENV.wawiInternalKey = '';
  for (const key of ['RESEND_API_KEY', 'BUNQ_API_KEY', 'DHL_API_KEY', 'DHL_TRACKING_API_KEY', 'FORGE_API_KEY']) assert.equal(process.env[key] || '', '', 'Provider credentials must be absent in isolated runner');
  mock.method(globalThis, 'fetch', async (request: any, init?: RequestInit) => {
    const url = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !allowedOrigins.has(url.origin)) { external++; throw Error('PRECISION_HTTP_NON_LOOPBACK_FORBIDDEN'); }
    return nativeFetch(request, { ...init, redirect: 'error' });
  });
  await closeDb(); ENV.databaseUrl = LOCAL_DATABASE; assert.equal(ENV.databaseUrl, LOCAL_DATABASE);
  pool = await getPool(); assert.ok(pool); assert.ok(await getDb());
  const connection = (await pool.query('SELECT current_user AS role, host(inet_server_addr()) AS host, inet_server_port() AS port')).rows[0];
  assert.deepEqual(connection, { role: 'priority_local', host: '127.0.0.1', port: 56439 });
  await pool.query(`CREATE TABLE IF NOT EXISTS substitution_config(id integer primary key,enabled boolean);
    INSERT INTO substitution_config VALUES(1,false) ON CONFLICT DO NOTHING;
    CREATE SEQUENCE IF NOT EXISTS precision_http_test_order_seq;
    CREATE OR REPLACE FUNCTION next_order_id() RETURNS text LANGUAGE sql AS $$ SELECT 'HTTP-TEST-' || nextval('precision_http_test_order_seq')::text $$;`);
  await ensureCustomerOrderBlockSchema(); await ensureGoodieSchema(); await ensureAdminChangeLogSchema(); await ensurePriorityOrderIntegritySchema();
  await ensurePermissionsSchema(); await ensureAccountSecuritySchema(); await ensurePartnerFinancialSchema(); await ensureCustomerDataChangeSchema();
  // Observe the real transaction declaration without replacing any SQL/result.
  // Preserve both callback and promise modes of pg.Pool/Client untouched.
  const clientQuery = pg.Client.prototype.query;
  mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...queryArgs: any[]) {
    const q = typeof queryArgs[0] === 'string' ? queryArgs[0] : queryArgs[0]?.text;
    if (/^BEGIN TRANSACTION.*READ ONLY/i.test(q || '')) readOnlyTransactions++;
    return (clientQuery as any).apply(this, queryArgs);
  });
  // Import the ACTUAL pure frontend helper, not a test copy. A computed URL keeps
  // the sibling frontend outside backend TypeScript rootDir/project expansion.
  const frontendHelperUrl = new URL('../../frontend/client/src/lib/checkoutIntent.ts', import.meta.url).href;
  frontendIntent = await import(frontendHelperUrl);
  const backendApp = express(); backendApp.use(express.json({ limit: '256kb' }));
  backendApp.use('/api/trpc', (req, _res, next) => { upstreamRequests++; if (req.headers.authorization) authorizedUpstreams++; next(); });
  backendApp.use('/api/trpc', createExpressMiddleware({ router: router({ order: orderRouter }), createContext: async ({ req, res }): Promise<Context> => ({ req, res, user: await getUserFromRequest(req), precisionShopPrincipal: resolvePrecisionShopPrincipal(req) }) }));
  backendOrigin = await listen(backendApp);
  const gatewayEnv = Object.freeze({ PRECISION_COMMERCE_ENABLED: 'true', PRECISION_COMMERCE_BACKEND_ENV: 'commerce-staging', PRECISION_COMMERCE_BACKEND_URL: backendOrigin, PRECISION_COMMERCE_GATEWAY_KEY: SYNTHETIC_GATEWAY_KEY });
  const handler = createPrecisionCommerceHandler({ env: gatewayEnv, allowLocalTest: true });
  const lossHandler = createPrecisionCommerceHandler({ env: gatewayEnv, allowLocalTest: true, fetchImpl: async (request: any, init: RequestInit) => {
    const response = await globalThis.fetch(request, init);
    if (loseNextCreateResponse && new URL(String(request)).pathname === '/api/trpc/order.create') {
      // Server completed the real commit and the full HTTP response was received,
      // but the gateway lost it. No fake receipt/business result is supplied.
      await response.text(); loseNextCreateResponse = false; throw Error('LOCAL_RESPONSE_LOST_AFTER_COMMIT');
    }
    return response;
  } });
  const gatewayApp = express(); gatewayApp.use(express.text({ type: '*/*', limit: '256kb' }));
  gatewayApp.all('/api/precision-commerce/*', async (req, res, next) => {
    try {
      const query = Object.fromEntries(new URL(req.originalUrl, 'http://127.0.0.1').searchParams);
      const event = { path: req.path, httpMethod: req.method, headers: req.headers, body: typeof req.body === 'string' ? req.body : '', isBase64Encoded: false, queryStringParameters: query };
      const result = await (loseNextCreateResponse ? lossHandler : handler)(event);
      res.status(result.statusCode).set(result.headers).send(result.body);
    } catch (error) { next(error); }
  });
  if (process.env.PRECISION_TEST_UI_SCRIPT) {
    assert.ok(process.env.PRECISION_TEST_UI_SCRIPT.startsWith(WORKSPACE) && process.env.PRECISION_TEST_UI_SCRIPT.endsWith('.py'), 'Parent UI script must be inside the isolated integration workspace');
    assert.ok((await stat(`${UI_PUBLIC}/index.html`)).isFile(), 'Parent must prepare static commerce UI artifact');
    gatewayApp.use(express.static(UI_PUBLIC)); gatewayApp.get('*', (_req, res) => res.sendFile(`${UI_PUBLIC}/index.html`));
  }
  gatewayOrigin = await listen(gatewayApp);
});

beforeEach(async () => {
  external = 0; upstreamRequests = 0; authorizedUpstreams = 0; readOnlyTransactions = 0; loseNextCreateResponse = false;
  await pool.query(`DROP TRIGGER IF EXISTS precision_http_fail_item ON order_items;
    UPDATE substitution_config SET enabled=false WHERE id=1;
    TRUNCATE customer_data_change_confirmations,customer_data_change_events,goodie_assignments,priority_stock_returns,priority_order_actions,priority_order_tasks,priority_checkout_receipts,stock_history,order_items,orders,customers,articles,partners,partner_programs,partner_codes,kwk_accounts,partner_transactions,kwk_ledger,kwk_referrals,invoices,shop_settings,promo_codes,users,bundles,bundle_items RESTART IDENTITY CASCADE;`);
  for (const a of fixtureArticles) await pool.query('INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,sale_price,variants) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,0,$8::jsonb)', [a.id, a.sku, a.name, a.family, a.id === ID.bac10 ? 20 : a.id === ID.bac3 ? 100 : 10, a.category, a.price, '[]']);
  await pool.query(`INSERT INTO customers(id,customer_number,name,first_name,last_name,email,phone,street,house_number,zip,city,country)
    VALUES(10001,'999001','Synthetic Owner','Synthetic','Owner','synthetic@example.test','+41790000000','Local','1','8000','Local','CH');
    INSERT INTO kwk_accounts(id,kwk_number,referral_code,name,email,phone,password_hash)
    VALUES(1,'KWK-1','KWK-1','Synthetic KWK','kwk1@example.test','1','unused'),(2,'KWK-2','KWK-2','Synthetic KWK 2','kwk2@example.test','2','unused');
    INSERT INTO shop_settings(key,value) VALUES('address_validation_enabled','false');
    INSERT INTO users(id,username,password_hash,name,email,role) VALUES(1,'synthetic-http-admin','unused','Synthetic Admin','admin@example.test','admin');`);
});
afterEach(() => assert.equal(external, 0, 'No provider/non-loopback fetch may be attempted'));
after(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  await closeDb(); ENV.databaseUrl = ''; ENV.jwtSecret = 'dev-secret-change-me';
  if (savedPrecisionEnabled === undefined) delete process.env.PRECISION_COMMERCE_ENABLED; else process.env.PRECISION_COMMERCE_ENABLED = savedPrecisionEnabled;
  if (savedGatewayKey === undefined) delete process.env.PRECISION_COMMERCE_GATEWAY_KEY; else process.env.PRECISION_COMMERCE_GATEWAY_KEY = savedGatewayKey;
  mock.restoreAll();
});

test('HTTP contract: actual gateway accepts POST for all three actual tRPC mutations', async () => {
  assert.equal(PROCEDURES['order.quote'], 'POST'); assert.equal(PROCEDURES['order.create'], 'POST'); assert.equal(PROCEDURES['order.checkoutReceipt'], 'POST');
  for (const procedure of ['quote', 'create', 'checkoutReceipt']) assert.equal((orderRouter as any)._def.procedures[procedure]._def.type, 'mutation');
  const r = await gateway('order.checkoutReceipt', receiptInput(input())); assert.equal(r.status, 200); assert.deepEqual(r.data, { state: 'not_found' });
  assert.equal(r.headers.get('cache-control'), 'no-store'); assert.match(r.headers.get('x-robots-tag') || '', /noindex/); assert.ok(readOnlyTransactions > 0);
  await denied(callAt(gatewayOrigin, 'order.checkoutReceipt', receiptInput(input()), {}, 'GET'), /METHOD_NOT_ALLOWED/);
  await noWrites();
});

test('HTTP auth: forged client gateway header rejected before forwarding; invalid backend claims rejected without disabling ordinary public vials', async () => {
  const original = await snapshot();
  for (const header of [PRECISION_COMMERCE_HEADER, 'X-369-Precision-Commerce-Key']) {
    const r = await denied(gateway('order.quote', input(), { [header]: SYNTHETIC_GATEWAY_KEY }), /CLIENT_PRINCIPAL_FORBIDDEN/); assert.equal(r.status, 403); assert.equal(upstreamRequests, 0); noPii(r);
  }
  const ordinary = input({ items: [line()] }); const publicQuote = await success(backend('order.quote', ordinary));
  assert.equal(publicQuote.quote.storeIdentity, undefined); assert.ok(publicQuote.quote.items.some((i: any) => i.isFreeGift && i.canonicalProductId === 'bac-wasser-3ml'));
  await denied(backend('order.quote', input()), /CHECKOUT_NASAL_FORMAT_RETIRED/);
  const missingReceipt = await denied(backend('order.checkoutReceipt', receiptInput(input())), /PRECISION_CHECKOUT_SCOPE_REQUIRED/); noPii(missingReceipt);
  for (const badKey of ['bad', 'b'.repeat(48)]) {
    const r = await denied(backend('order.quote', ordinary, { [PRECISION_COMMERCE_HEADER]: badKey }), /PRECISION_COMMERCE_GATEWAY_UNAUTHORIZED/); assert.equal(r.status, 401); noPii(r);
  }
  await denied(backend('order.quote', ordinary, { 'x-369-precision-commerce-scope': 'precision-shop' }), /SCOPE_CLAIM_INVALID/);
  assert.deepEqual(await snapshot(), original);
});

test('HTTP frontend fingerprint equals actual schema-defaulted backend fingerprint and excludes only transport/proof metadata', async () => {
  const payload = input({ confirmations: { researchOnly: true, diyAcknowledged: true } });
  delete payload.orderSource; delete payload.storeKey;
  const parsed = createOrderSchema.parse(payload);
  assert.equal(parsed.orderSource, 'shop'); assert.equal(parsed.storeKey, '369research'); assert.equal(parsed.communicationLanguage, 'de'); assert.equal(parsed.customer.deliveryType, 'home');
  assert.equal(clientFingerprint(payload), checkoutFingerprint(parsed));
  const memory = new Map<string, string>();
  const evidence = await frontendIntent.getCheckoutIntent(payload, { getItem: (key: string) => memory.get(key) || null, setItem: (key: string, value: string) => memory.set(key, value) });
  assert.equal(evidence.fingerprint, checkoutFingerprint(parsed)); assert.match(evidence.key, /^[a-f0-9]{64}$/);
  const renewed = { ...payload, date: '2026-12-01', orderId: 'IGNORED', expectedQuoteHash: 'f'.repeat(64), checkoutIdempotencyKey: 'b'.repeat(64), kwkCreditToken: 'synthetic-proof-only', customerDataChangeConfirmationToken: 'c'.repeat(40), confirmations: { changedClientMetadata: true } };
  assert.equal(clientFingerprint(renewed), clientFingerprint(payload)); assert.equal(checkoutFingerprint(createOrderSchema.parse(renewed)), clientFingerprint(payload));
  assert.notEqual(clientFingerprint({ ...payload, customer: { ...payload.customer, street: 'Changed Local' } }), clientFingerprint(payload));
  assert.notEqual(clientFingerprint({ ...payload, items: [kit('adamax', 2)] }), clientFingerprint(payload));
  await noWrites();
});

test('HTTP quote is database READ ONLY; canonical DIY price is vial+7 per unit and BAC10 is planned without writes', async () => {
  const payload = input({ items: [{ ...kit('adamax', 2), name: 'Forged price/name', type: 'accessory', price: 0 }], subtotal: 0, shipping: 0, total: 0 });
  const original = await snapshot(); const reads = readOnlyTransactions; const q = await quote(payload);
  assert.ok(readOnlyTransactions > reads, 'Actual READ ONLY transaction must be used'); assert.deepEqual(await snapshot(), original);
  assert.equal(q.storeIdentity, 'precision-shop'); assert.equal(q.policy, PRECISION_COMMERCE_POLICY); assert.match(q.hash, /^[a-f0-9]{64}$/);
  const paid = q.items.find((i: any) => !i.isFreeGift); assert.equal(paid.price, article('adamax').price + 7); assert.equal(paid.name, article('adamax').name); assert.equal(paid.type, 'peptide'); assert.equal(paid.quantity, 2);
  assert.equal(paid.isNasalSpray, true); assert.equal(paid.isNasalDiySet, true); assert.equal(q.subtotal, (article('adamax').price + 7) * 2); assert.equal(q.shipping, 18); assert.equal(q.total, q.subtotal - q.discount + q.shipping);
  const bac = q.items.filter((i: any) => i.canonicalProductId === 'bac-wasser'); assert.equal(bac.length, 1); assert.equal(bac[0].quantity, 2); assert.equal(bac[0].price, 0); assert.equal(bac[0].isFreeGift, true);
  assert.equal(q.items.some((i: any) => i.shopProductId === 'bac-wasser-3ml'), false); assert.equal(q.kitComposition.length, 3); await noWrites();
});

test('HTTP committed DIY BOM has exactly three accessory components and only one tracked BAC10 deduction per kit unit', async () => {
  const payload = input({ items: [kit('adamax', 2)] }); const q = await quote(payload);
  const created = await success(gateway('order.create', { ...payload, expectedQuoteHash: q.hash }));
  const rows = (await pool.query('SELECT name,type,price,quantity,article_id,is_nasal_spray,is_nasal_diy_set FROM order_items WHERE order_id=$1 ORDER BY id', [created.orderId])).rows;
  assert.equal(rows.length, 4); const components = rows.filter((r: any) => r.type === 'accessory');
  assert.deepEqual(components.map((r: any) => r.name).sort(), NASAL_DIY_SET_COMPONENTS.map(c => c.name).sort());
  assert.ok(components.every((r: any) => r.price === '0.00' && r.quantity === 2));
  assert.equal(components.filter((r: any) => r.article_id !== null).length, 1); assert.equal(components.find((r: any) => r.article_id !== null).article_id, ID.bac10);
  assert.equal(rows[0].is_nasal_spray, true); assert.equal(rows[0].is_nasal_diy_set, true);
  assert.equal(await stock(ID.adamax), 10 - 2); assert.equal(await stock(ID.bac10), 20 - 2); assert.equal(await stock(ID.bac3), 100);
  assert.deepEqual(await movements(created.orderId), [{ article_id: ID.adamax, used: 2 }, { article_id: ID.bac10, used: 2 }]);
  assert.equal(await count('orders'), 1); assert.equal(await count('priority_checkout_receipts'), 1); assert.equal(await count('customers'), 1);
  assert.equal(created.quote.hash, q.hash); assert.equal(created.orderSnapshot.items.length, 4);
  const recovered = await receipt(payload); assert.equal(recovered.state, 'committed'); assert.equal(recovered.receipt.orderId, created.orderId); assert.deepEqual(recovered.receipt.quote, JSON.parse(JSON.stringify(created.quote)));
  assert.equal(recovered.receipt.customer.email, CUSTOMER.email); assert.equal(recovered.receipt.date, payload.date); assert.equal(recovered.receipt.paymentMethod, 'SEPA'); assert.ok(Object.hasOwn(recovered.receipt, 'paymentInstructions'));
  const stored = (await pool.query('SELECT payload_fingerprint,response FROM priority_checkout_receipts')).rows[0];
  assert.equal(stored.payload_fingerprint, precisionReceiptFingerprint(clientFingerprint(payload))); assert.deepEqual(stored.response, recovered.receipt);
});

test('HTTP format allowlists: exactly 13 cartridges +15 and seven DIY families +7; BPC, forged names/types and contradictory flags fail closed', async () => {
  assert.deepEqual([...PRECISION_CARTRIDGE_FAMILIES].sort(), [...EXPECTED_CARTRIDGES].sort()); assert.equal(PRECISION_CARTRIDGE_FAMILIES.size, 13);
  assert.deepEqual([...PRECISION_NASAL_FAMILIES].sort(), [...EXPECTED_NASAL].sort());
  const original = await snapshot();
  for (const family of EXPECTED_CARTRIDGES) {
    const q = await quote(input({ items: [line(family, { isPlugPlay: true })] })); const paid = q.items.find((i: any) => !i.isFreeGift);
    assert.equal(paid.price, article(family).price + 15, family); assert.equal(paid.isPlugPlay, true); assert.equal(q.items.some((i: any) => i.isFreeGift), false);
  }
  for (const family of EXPECTED_NASAL) { const q = await quote(input({ items: [kit(family)] })); assert.equal(q.items.find((i: any) => !i.isFreeGift).price, article(family).price + 7, family); }
  for (const invalid of [kit('bpc-157'), line('bpc-157', { name: 'Retatrutide', type: 'accessory', isPlugPlay: true }), line('adamax', { isPlugPlay: true }), line('bac-wasser', { isPlugPlay: true }), line('adamax', { isNasalSpray: true }), line('adamax', { isNasalDiySet: true }), { ...kit(), isPlugPlay: true }, line('adamax', { variant: 'DIY-Set' })]) {
    await denied(gateway('order.quote', input({ items: [invalid] })), /PRECISION_CHECKOUT_FORMAT_(?:INVALID|UNSUPPORTED)/);
    await denied(gateway('order.create', input({ items: [invalid], expectedQuoteHash: 'f'.repeat(64) })), /PRECISION_CHECKOUT_FORMAT_(?:INVALID|UNSUPPORTED)/);
  }
  assert.deepEqual(await snapshot(), original);
});

test('HTTP mixed vial/DIY/cartridge cart: +7/+15 canonical prices; only ordinary vial units get free BAC3', async () => {
  const payload = input({ items: [line('selank', { quantity: 2 }), kit(), line('3g-triple-g', { isPlugPlay: true })] }); const q = await quote(payload);
  assert.equal(q.items.find((i: any) => i.canonicalProductId === 'adamax').price, article('adamax').price + 7);
  assert.equal(q.items.find((i: any) => i.canonicalProductId === '3g-triple-g').price, article('3g-triple-g').price + 15);
  assert.equal(q.items.find((i: any) => i.isFreeGift && i.canonicalProductId === 'bac-wasser-3ml').quantity, 2);
  const created = await success(gateway('order.create', { ...payload, expectedQuoteHash: q.hash }));
  assert.equal(await stock(ID.selank), 10 - 2); assert.equal(await stock(ID.adamax), 10 - 1); assert.equal(await stock(ID.retatrutide), 10 - 1); assert.equal(await stock(ID.bac10), 20 - 1); assert.equal(await stock(ID.bac3), 100 - 2);
  const used = await movements(created.orderId); assert.equal(used.find((r: any) => r.article_id === ID.bac10).used, 1); assert.equal(used.find((r: any) => r.article_id === ID.bac3).used, 2);
});

test('HTTP aggregate demand: explicit paid BAC10 plus two kits consume the same stock pool exactly once', async () => {
  await pool.query('UPDATE articles SET stock=5 WHERE id=$1', [ID.bac10]);
  const payload = input({ items: [kit('adamax', 2), line('bac-wasser', { quantity: 3 })] }); const q = await quote(payload);
  const bacLines = q.items.filter((i: any) => i.canonicalProductId === 'bac-wasser'); assert.equal(bacLines.length, 2); assert.equal(bacLines.reduce((n: number, i: any) => n + i.quantity, 0), 5);
  assert.equal(bacLines.find((i: any) => !i.isFreeGift).price, article('bac-wasser').price);
  const created = await success(gateway('order.create', { ...payload, expectedQuoteHash: q.hash })); assert.equal(await stock(ID.bac10), 0); assert.equal(await stock(ID.bac3), 100);
  assert.equal((await movements(created.orderId)).find((r: any) => r.article_id === ID.bac10).used, 5);
  const original = await snapshot(); await success(gateway('order.create', { ...payload, expectedQuoteHash: q.hash })); assert.deepEqual(await snapshot(), original);
});

test('HTTP overselling: combined BAC10 paid+kit demand, duplicate vial/kit lines and invalid quantities reject before any write', async () => {
  await pool.query('UPDATE articles SET stock=4 WHERE id=$1', [ID.bac10]);
  let original = await snapshot(); await denied(gateway('order.quote', input({ items: [kit('adamax', 2), line('bac-wasser', { quantity: 3 })] })), /CHECKOUT_STOCK_DEMAND_NOT_COVERED/); assert.deepEqual(await snapshot(), original);
  await pool.query('UPDATE articles SET stock=1 WHERE id=$1', [ID.adamax]); original = await snapshot();
  const duplicates = input({ items: [kit(), kit()] }); await denied(gateway('order.quote', duplicates), /CHECKOUT_STOCK_DEMAND_NOT_COVERED/); await denied(gateway('order.create', { ...duplicates, expectedQuoteHash: 'f'.repeat(64) }), /CHECKOUT_STOCK_DEMAND_NOT_COVERED/); assert.deepEqual(await snapshot(), original);
  for (const quantity of [-1, 0, 0.5]) { const r = await denied(gateway('order.quote', input({ items: [kit('adamax', quantity)] }))); assert.equal(r.status, 400); }
  await noWrites();
});

test('HTTP BAC10 identity fails closed when missing/inactive/ambiguous/wrong category; never substitutes abundant BAC3', async () => {
  const valid = article('bac-wasser');
  for (const condition of ['missing', 'inactive', 'ambiguous', 'category', 'negative']) {
    if (condition === 'missing') await pool.query('DELETE FROM articles WHERE id=$1', [ID.bac10]);
    if (condition === 'inactive') await pool.query('UPDATE articles SET is_active=0 WHERE id=$1', [ID.bac10]);
    if (condition === 'ambiguous') await pool.query("INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,sale_price,variants) VALUES(19010,'AMBIGUOUS-BAC-10ML','Synthetic duplicate BAC (10 ml)','bac-wasser',20,1,0,'Zubehör',5,0,'[]')");
    if (condition === 'category') await pool.query("UPDATE articles SET category='Peptide' WHERE id=$1", [ID.bac10]);
    if (condition === 'negative') await pool.query('UPDATE articles SET stock=-1 WHERE id=$1', [ID.bac10]);
    const original = await snapshot(); await denied(gateway('order.quote', input()), /PRECISION_CHECKOUT_BAC10_INVENTORY_REQUIRED/); await denied(gateway('order.create', input({ expectedQuoteHash: 'f'.repeat(64) })), /PRECISION_CHECKOUT_BAC10_INVENTORY_REQUIRED/); assert.deepEqual(await snapshot(), original); assert.equal(await stock(ID.bac3), 100); await noWrites();
    await pool.query('DELETE FROM articles WHERE id=19010');
    if (condition === 'missing') await pool.query('INSERT INTO articles(id,sku,name,shop_product_id,stock,is_active,shop_visible,category,selling_price,sale_price,variants) VALUES($1,$2,$3,$4,20,1,1,$5,$6,0,$7::jsonb)', [valid.id, valid.sku, valid.name, valid.family, valid.category, valid.price, '[]']);
    else await pool.query("UPDATE articles SET stock=20,is_active=1,category='Zubehör' WHERE id=$1", [ID.bac10]);
  }
});

test('HTTP concurrency: identical-key requests commit one order/receipt and one kit stock deduction', async () => {
  const payload = input(); const q = await quote(payload); const submitted = { ...payload, expectedQuoteHash: q.hash };
  const results = await Promise.all([success(gateway('order.create', submitted)), success(gateway('order.create', submitted))]);
  assert.equal(results[0].orderId, results[1].orderId); assert.equal(await count('orders'), 1); assert.equal(await count('priority_checkout_receipts'), 1); assert.equal(await count('stock_history'), 2);
  assert.equal(await stock(ID.adamax), 9); assert.equal(await stock(ID.bac10), 19); assert.equal(await stock(ID.bac3), 100);
  const original = await snapshot(); const replay = await success(gateway('order.create', { ...submitted, date: '2026-12-01' })); assert.equal(replay.orderId, results[0].orderId); assert.deepEqual(await snapshot(), original);
});

test('HTTP concurrency: different intents racing for the last vial/BAC10 cannot oversell or underflow', async () => {
  await pool.query('UPDATE articles SET stock=1 WHERE id=ANY($1::int[])', [[ID.adamax, ID.bac10]]);
  const a = input(); const b = input({ checkoutIdempotencyKey: 'b'.repeat(64) }); const qa = await quote(a); const qb = await quote(b);
  const results = await Promise.all([gateway('order.create', { ...a, expectedQuoteHash: qa.hash }), gateway('order.create', { ...b, expectedQuoteHash: qb.hash })]);
  assert.equal(results.filter(r => r.status === 200).length, 1); assert.equal(results.filter(r => r.status >= 400).length, 1);
  assert.equal(await count('orders'), 1); assert.equal(await count('priority_checkout_receipts'), 1); assert.equal(await count('stock_history'), 2); assert.equal(await stock(ID.adamax), 0); assert.equal(await stock(ID.bac10), 0); assert.equal(await stock(ID.bac3), 100);
  assert.equal(Number((await pool.query('SELECT count(*)::int n FROM articles WHERE stock<0')).rows[0].n), 0);
});

test('HTTP lost create response: real committed receipt recovers original quote/customer/date/payment, then replay never buys/deducts twice', async () => {
  const payload = input(); const q = await quote(payload); const submitted = { ...payload, expectedQuoteHash: q.hash };
  loseNextCreateResponse = true; const uncertain = await denied(gateway('order.create', submitted), /PRECISION_COMMERCE_OUTCOME_UNCERTAIN/); assert.equal(uncertain.status, 502); noPii(uncertain);
  assert.equal(await count('orders'), 1); assert.equal(await stock(ID.bac10), 19);
  const original = await snapshot(); const reads = readOnlyTransactions; const recovered = await receipt(payload);
  assert.ok(readOnlyTransactions > reads); assert.equal(recovered.state, 'committed'); assert.equal(recovered.receipt.quote.hash, q.hash); assert.equal(recovered.receipt.customer.email, CUSTOMER.email); assert.equal(recovered.receipt.date, payload.date); assert.equal(recovered.receipt.paymentMethod, payload.paymentMethod);
  assert.deepEqual(await snapshot(), original);
  const replay = await success(gateway('order.create', submitted)); assert.equal(replay.orderId, recovered.receipt.orderId); assert.deepEqual(replay, recovered.receipt); assert.deepEqual(await snapshot(), original);
});

test('HTTP receipt ownership: wrong key/fingerprint/contact intent and unscoped requests never disclose persisted PII or unlock a different purchase', async () => {
  const payload = input(); const created = await create(payload); const original = await snapshot();
  for (const proof of [{ ...receiptInput(payload), payloadFingerprint: 'b'.repeat(64) }, { ...receiptInput(payload), checkoutIdempotencyKey: 'c'.repeat(64) }, receiptInput({ ...payload, customer: { ...payload.customer, email: 'other@example.test' } })]) {
    const r = await gateway('order.checkoutReceipt', proof); assert.equal(r.status, 200); assert.deepEqual(r.data, { state: 'not_found' }); noPii(r, created.orderId);
  }
  const unscoped = await denied(backend('order.checkoutReceipt', receiptInput(payload)), /PRECISION_CHECKOUT_SCOPE_REQUIRED/); noPii(unscoped, created.orderId);
  const badKey = await denied(backend('order.checkoutReceipt', receiptInput(payload), { [PRECISION_COMMERCE_HEADER]: 'b'.repeat(48) }), /UNAUTHORIZED/); noPii(badKey, created.orderId);
  const changed = await denied(gateway('order.create', { ...payload, customer: { ...payload.customer, street: 'Different Local' }, expectedQuoteHash: created.quote.hash }), /CHECKOUT_INTENT_CONFLICT/); noPii(changed, created.orderId);
  assert.deepEqual(await snapshot(), original);
});

test('HTTP receipt domains: ordinary legacy create/status remains valid; ordinary and Precision receipts/hashes cannot be cross-read or replayed', async () => {
  const ordinary = input({ items: [line()], checkoutIdempotencyKey: 'b'.repeat(64) }); const legacyQ = (await success(backend('order.quote', ordinary))).quote;
  const precisionQ = await quote(ordinary); assert.notEqual(legacyQ.hash, precisionQ.hash);
  const legacy = await success(backend('order.create', { ...ordinary, expectedQuoteHash: legacyQ.hash }));
  const hidden = await gateway('order.checkoutReceipt', receiptInput(ordinary)); assert.deepEqual(hidden.data, { state: 'not_found' }); noPii(hidden, legacy.orderId);
  assert.deepEqual(await success(backend('order.checkoutStatus', receiptInput(ordinary), {}, 'GET')), { state: 'committed', orderId: legacy.orderId });
  const cross = await denied(gateway('order.create', { ...ordinary, expectedQuoteHash: precisionQ.hash }), /CHECKOUT_INTENT_CONFLICT/); noPii(cross, legacy.orderId);
  const precision = input({ items: [line()] }); const q = await quote(precision); const created = await success(gateway('order.create', { ...precision, expectedQuoteHash: q.hash }));
  const original = await snapshot(); const ordinaryQ = (await success(backend('order.quote', precision))).quote;
  const replay = await denied(backend('order.create', { ...precision, expectedQuoteHash: ordinaryQ.hash }), /CHECKOUT_INTENT_CONFLICT/); noPii(replay, created.orderId);
  const status = await success(backend('order.checkoutStatus', receiptInput(precision), {}, 'GET')); assert.deepEqual(status, { state: 'not_found' });
  assert.deepEqual(await snapshot(), original); assert.equal(await stock(ID.bac10), 20); assert.equal(await stock(ID.bac3), 100 - 2);
});

test('HTTP principal cannot select manual/P4P/V2/admin/customer/stock override; body claims never become capabilities', async () => {
  const original = await snapshot();
  for (const extra of [{ orderSource: 'wawi_manual' }, { storeKey: 'peps4pets' }, { storeKey: 'checkout-v2' }, { stockOverride: { enabled: true, reason: 'Synthetic override attempt' } }, { existingCustomerId: 10001 }]) {
    for (const procedure of ['order.quote', 'order.create']) await denied(gateway(procedure, input({ ...extra, expectedQuoteHash: 'f'.repeat(64) })));
    // Bypass the gateway to test the actual backend principal's restrictions too.
    for (const procedure of ['order.quote', 'order.create']) await denied(backend(procedure, input({ ...extra, expectedQuoteHash: 'f'.repeat(64) }), { [PRECISION_COMMERCE_HEADER]: SYNTHETIC_GATEWAY_KEY }));
  }
  for (const claim of ['precisionShopPrincipal', 'operationsPreview', 'jarvyOrder', 'screenshotOrder']) {
    const beforeRequests = upstreamRequests; const r = await denied(gateway('order.quote', input({ [claim]: { role: 'admin' } })), /INVALID_SCOPE/); assert.equal(r.status, 403); assert.equal(upstreamRequests, beforeRequests);
  }
  const admin = { Authorization: `Bearer ${createToken(1, 'admin')}` };
  await denied(gateway('order.quote', input(), admin), /PRECISION_CHECKOUT_SCOPE_INVALID/);
  await denied(gateway('order.create', input({ expectedQuoteHash: 'f'.repeat(64) }), admin), /PRECISION_CHECKOUT_SCOPE_INVALID/);
  await denied(gateway('order.checkoutReceipt', receiptInput(input()), admin), /PRECISION_CHECKOUT_SCOPE_REQUIRED/);
  assert.deepEqual(await snapshot(), original);
});

test('HTTP rollback: failure inserting the descriptive bottle component rolls back order, receipt, customer and already-planned vial/BAC10 stock; same key is retryable', async () => {
  const payload = input({ items: [kit('adamax', 2)] }); const q = await quote(payload); const original = await snapshot();
  await pool.query(`CREATE OR REPLACE FUNCTION precision_http_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.name='DIY Nasenspray-Set · Leere Nasensprayflasche' THEN RAISE EXCEPTION 'LOCAL_HTTP_BOM_INSERT_FAILURE'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER precision_http_fail_item BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION precision_http_fail();`);
  await denied(gateway('order.create', { ...payload, expectedQuoteHash: q.hash }), /LOCAL_HTTP_BOM_INSERT_FAILURE|Failed query/); assert.deepEqual(await snapshot(), original); await noWrites();
  await pool.query('DROP TRIGGER precision_http_fail_item ON order_items'); const retry = await success(gateway('order.create', { ...payload, expectedQuoteHash: q.hash })); assert.equal(retry.success, true); assert.equal(await stock(ID.bac10), 20 - 2); assert.equal(await count('orders'), 1);
});

test('HTTP stale authoritative quote rejects before writes after catalog price changes', async () => {
  const payload = input(); const q = await quote(payload); await pool.query('UPDATE articles SET selling_price=21 WHERE id=$1', [ID.adamax]);
  const original = await snapshot(); await denied(gateway('order.create', { ...payload, expectedQuoteHash: q.hash }), /CHECKOUT_QUOTE_CHANGED/); assert.deepEqual(await snapshot(), original);
  await denied(gateway('order.create', payload), /CHECKOUT_QUOTE_REQUIRED/); await noWrites();
});

test('HTTP real general promo: quote does not consume a use; create/receipt/replay retain the same canonical code benefit exactly once', async () => {
  await pool.query("INSERT INTO promo_codes(code,discount_type,percentage,valid_until) VALUES('HTTP-SYNTHETIC-TEN','percent',10,'2099-01-01')");
  const payload = input({ discountCode: 'http-synthetic-ten' }); const original = await snapshot(); const q = await quote(payload); assert.deepEqual(await snapshot(), original);
  assert.equal(q.discountCode, 'HTTP-SYNTHETIC-TEN'); assert.ok(q.discount > 0); assert.ok(q.discountBreakdown.some((r: any) => r.source === 'promotion_code'));
  const created = await success(gateway('order.create', { ...payload, expectedQuoteHash: q.hash })); assert.deepEqual(created.quote, q);
  assert.equal(Number((await pool.query('SELECT current_uses FROM promo_codes')).rows[0].current_uses), 1);
  const committed = await snapshot(); await receipt(payload); await success(gateway('order.create', { ...payload, expectedQuoteHash: q.hash })); assert.deepEqual(await snapshot(), committed);
});

test('HTTP real expired promo: Precision quote drops only the expired code; receipt fingerprint still proves the original submitted intent', async () => {
  await pool.query("INSERT INTO promo_codes(code,discount_type,percentage,valid_until,valid_until_exact) VALUES('HTTP-SYNTHETIC-EXPIRED','percent',10,'2000-01-01',1)");
  const payload = input({ discountCode: 'HTTP-SYNTHETIC-EXPIRED' }); const q = await quote(payload); assert.equal(q.droppedPromotionCode, true); assert.equal(q.discountCode, null); assert.equal(q.discount, 0);
  const created = await success(gateway('order.create', { ...payload, expectedQuoteHash: q.hash })); assert.equal((await receipt(payload)).receipt.orderId, created.orderId); assert.equal(Number((await pool.query('SELECT current_uses FROM promo_codes')).rows[0].current_uses), 0);
  assert.equal((await pool.query('SELECT discount_code FROM orders')).rows[0].discount_code, null);
});

test('HTTP real KWK credit parity: authenticated owner overrides browser owner; read-only quote, debit/cache/order/receipt commit once', async () => {
  await pool.query("INSERT INTO kwk_ledger(kwk_id,type,amount,status) VALUES(1,'manual_correction',50,'confirmed')"); await syncKwkAccountCache(1, pool);
  const payload = input({ kwkCreditUsed: 10, kwkCreditKwkId: 2, kwkCreditToken: createKwkToken(1) }); const original = await snapshot(); const q = await quote(payload); assert.deepEqual(await snapshot(), original); assert.equal(q.kwkCreditUsed, 10);
  const submitted = { ...payload, expectedQuoteHash: q.hash }; const created = await success(gateway('order.create', submitted)); assert.equal(created.quote.kwkCreditUsed, q.kwkCreditUsed);
  assert.equal((await pool.query('SELECT kwk_credit_owner_id FROM orders')).rows[0].kwk_credit_owner_id, 1);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM kwk_ledger WHERE type='redeemed'")).rows[0].n), 1); assert.equal((await pool.query('SELECT credit_available FROM kwk_accounts WHERE id=1')).rows[0].credit_available, '40.00');
  const committed = await snapshot(); assert.equal((await receipt(payload)).receipt.orderId, created.orderId); await success(gateway('order.create', submitted)); assert.deepEqual(await snapshot(), committed);
});

test('HTTP actual signed partner session traverses gateway without WaWi auth; quote/create/credit/receipt parity and replay no double debit', async () => {
  await pool.query(`INSERT INTO partner_programs(key,label,customer_discount_policy,commission_policy,settlement_method,allow_self_order_credit,active)
    VALUES('partner','Synthetic Partner','first_paid_code_use','first_paid_code_order','shop_credit',true,true);
    INSERT INTO partners(id,name,email,code,partner_number,credit_balance,customer_discount_percent,commission_percent,program_key)
    VALUES(9,'Synthetic Owner','synthetic@example.test','HTTP-PARTNER','HTTP-OWN9',50,10,10,'partner');`);
  const payload = input({ partnerNumber: 'HTTP-OWN9', creditUsed: 5 }); const original = await snapshot();
  await denied(gateway('order.quote', payload), /PARTNER_GUTHABEN_AUTHENTIFIZIERUNG_ERFORDERLICH/); assert.deepEqual(await snapshot(), original);
  const headers = { Authorization: `Bearer ${createPartnerToken(9)}` }; const q = await quote(payload, headers); assert.ok(authorizedUpstreams > 0); assert.equal(q.creditUsed, 5); assert.ok(q.partnerDiscount > 0); assert.deepEqual(await snapshot(), original);
  const submitted = { ...payload, expectedQuoteHash: q.hash }; const created = await success(gateway('order.create', submitted, headers)); assert.deepEqual(created.quote, q);
  assert.equal((await pool.query('SELECT partner_source_id FROM orders')).rows[0].partner_source_id, 9); assert.equal((await pool.query('SELECT credit_balance FROM partners WHERE id=9')).rows[0].credit_balance, '45.00');
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM partner_transactions WHERE type='einloesung'")).rows[0].n), 1);
  const committed = await snapshot(); await success(gateway('order.create', submitted, headers)); assert.equal((await receipt(payload)).receipt.orderId, created.orderId); assert.deepEqual(await snapshot(), committed);
});

// Parent-owned optional acceptance script: never used by the ordinary suite.
// The runner allowlists PRECISION_TEST_UI_SCRIPT; child inherits no API/DB/JWT key.
// Two isolated browser contexts (desktop + mobile) each purchase one Adamax kit.
// Parent mocks ONLY public catalog/address/payment reads, not Precision POSTs.
test('OPTIONAL actual browser UI desktop/mobile commits two synthetic Adamax kits through the same real gateway/PG', { skip: !process.env.PRECISION_TEST_UI_SCRIPT, timeout: 180_000 }, async () => {
  const script = process.env.PRECISION_TEST_UI_SCRIPT!;
  assert.equal(script, BROWSER_SCRIPT, 'Only the versioned synthetic browser driver is permitted');
  // Browser's existing country selector sends Schweiz, not ISO CH. Keep the
  // identical contact fixture exact so this test doesn't require an unrelated
  // customer-data change confirmation interaction in the parent UI script.
  await pool.query("UPDATE customers SET country='Schweiz' WHERE id=10001");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('python3', [script], { cwd: WORKSPACE, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/home/ubuntu', GATEWAY_ORIGIN: gatewayOrigin }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('LOCAL_UI_SCRIPT_TIMEOUT')); }, 150_000);
    const collect = (chunk: Buffer) => { text += chunk.toString(); if (text.length > 1024 * 1024) { child.kill('SIGKILL'); clearTimeout(timer); reject(Error('LOCAL_UI_SCRIPT_OUTPUT_LIMIT')); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(Error(`LOCAL_UI_SCRIPT_FAILED (${code}): ${text}`)); });
  });
  console.log(output);
  assert.equal(await count('orders'), 2); assert.equal(await count('priority_checkout_receipts'), 2); assert.equal(await stock(ID.adamax), 10 - 2); assert.equal(await stock(ID.bac10), 20 - 2); assert.equal(await stock(ID.bac3), 100);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM order_items WHERE name='DIY Nasenspray-Set · Leere Nasensprayflasche'")).rows[0].n), 2);
  assert.ok(upstreamRequests >= 4, 'Each browser must really quote and create over gateway HTTP');
});

test('HTTP actual fourth scoped customer confirmation preserves quote read-only and consumes proof on locked create', async () => {
  const changed = input({customer:{...CUSTOMER,street:'Synthetic New Street'}});
  const before = await snapshot();
  const preflight = await success(gateway('order.quote', changed));
  assert.equal(preflight.customerDataChangeConfirmation.requiresConfirmation,true);
  assert.equal(preflight.customerDataChangeConfirmation.confirmationToken,null);
  assert.deepEqual(await snapshot(),before);
  assert.equal(await count('customer_data_change_confirmations'),0);
  const proof = await success(gateway('order.checkoutCustomerConfirmation',{storeKey:'369research',orderSource:'shop',customer:changed.customer}));
  assert.equal(proof.requiresConfirmation,true); assert.ok(proof.confirmationToken);
  assert.equal(await count('orders'),0); assert.equal(await count('stock_history'),0);
  assert.equal(await count('customer_data_change_confirmations'),1);
  const committed = await create({...changed,customerDataChangeConfirmationToken:proof.confirmationToken});
  assert.equal(committed.customer.street,'Synthetic New Street');
  assert.equal(await count('orders'),1); assert.equal(await stock(ID.bac10),19);
  assert.equal((await receipt(changed)).receipt.orderId,committed.orderId);
  const deniedProof = await denied(backend('order.checkoutCustomerConfirmation',{storeKey:'369research',orderSource:'shop',customer:changed.customer}),/PRECISION_CHECKOUT_SCOPE_REQUIRED/);
  noPii(deniedProof);
});
