import assert from 'node:assert/strict';
import test, { mock, after } from 'node:test';
import { Param } from 'drizzle-orm';
import * as schema from '../drizzle/schema.js';
import { readFileSync } from 'node:fs';
const financial = JSON.parse(readFileSync(new URL('./__fixtures__/order-discount-message-v1/synthetic.json', import.meta.url), 'utf8')).cases[0].snapshot;
const order: any = { ...financial, orderId: 'SYNTHETIC-1', status: 'versendet', communicationLanguage: 'de', customerId: 1, firstName: 'Ada', lastName: 'Test', email: 'ada@synthetic.invalid', phone: '000', street: 'Test', houseNumber: '1', zip: '12345', city: 'Test', country: 'DE', orderDate: new Date('2026-11-01T10:00:00Z'), paymentMethod: 'wise', storeKey: '369research' };
const customer = { id: 1, name: 'Ada Test', firstName: 'Ada', email: order.email, customerNumber: 'C-1' };
const item = { id: 1, orderId: order.orderId, name: 'Persisted item', price: '284.00', quantity: 1, type: 'vial', dosage: '5 mg', isPlugPlay: false, isNasalSpray: false, isNasalDiySet: false };
const families = ['order_confirmation', 'payment_received', 'packing_registered', 'shipping_registered', 'delivery_follow_up', 'address_clarification', 'payment_reminder', 'cancellation_warning'];
const templates: any[] = [];
for (const templateKey of [...families, 'active_custom', 'support_general']) for (const language of ['de', 'en']) for (const channel of ['email', 'whatsapp']) templates.push({ id: templates.length + 1, templateKey, language, channel, title: templateKey, version: 7, isActive: 1, subjectTemplate: 'Order {{orderId}}', bodyTemplate: 'Custom preserved {{firstName}}\nhttps://synthetic.invalid/help', sortOrder: 1 });
const followup: any = { id: 1, orderId: order.orderId, emailBody: '<html><body><p>Cached offer [DISCOUNT_CODE], [ABLAUFDATUM]</p></body></html>', emailSubject: 'Synthetic offer', discountCode: 'SYNTHETIC-CODE', codeExpiresAt: new Date('2099-11-01T10:00:00Z') };
const tables = new Map<any, any[]>([[schema.orders, [order]], [schema.customers, [customer]], [schema.orderItems, [item]], [schema.communicationTemplates, templates], [schema.shopSettings, []], [schema.customerCommunications, []], [schema.salesFollowups, [followup]], [schema.salesFollowupProducts, []]]);
const reads: any[] = [], writes: any[] = [], payloads: any[] = [];
function params(condition: any): any[] { if (condition instanceof Param) return [condition.value]; return (condition?.queryChunks ?? []).flatMap(params); }
function rowsFor(table: any, condition?: any) {
  let rows = tables.get(table) ?? [];
  const ps = params(condition);
  if (ps.length) {
    if (table === schema.orders) rows = rows.filter(row => ps.includes(row.orderId) || ps.includes(row.externalOrderReference));
    else if (table === schema.orderItems) rows = rows.filter(row => ps.includes(row.orderId));
    else if (table === schema.customerCommunications) rows = rows.filter(row => ps.includes(row.id) || ps.includes(row.idempotencyKey));
    else rows = rows.filter(row => ps.includes(row.id));
  }
  return rows;
}
const db: any = {
  select: () => ({ from: (table: any) => {
    reads.push(table);
    let condition: any;
    const chain: any = { where: (value: any) => { condition = value; return chain; }, limit: async (n: number) => rowsFor(table, condition).slice(0, n), orderBy: async () => rowsFor(table, condition), then: (resolve: any) => Promise.resolve(rowsFor(table, condition)).then(resolve) };
    return chain;
  } }),
  insert: (table: any) => ({ values: (values: any) => {
    writes.push({ table, values });
    const row = { id: (tables.get(table)?.length ?? 0) + 1, ...values };
    tables.set(table, [...(tables.get(table) ?? []), row]);
    return { returning: async () => [row], then: (resolve: any) => Promise.resolve(undefined).then(resolve) };
  } }),
  update: (table: any) => ({ set: (values: any) => ({ where: async (condition: any) => { writes.push({ table, values }); for (const row of rowsFor(table, condition)) Object.assign(row, values); } }) }),
};
mock.module(new URL('./db.ts', import.meta.url).href, { namedExports: { getDb: async () => db, getPool: async () => null, closeDb: async () => {}, withReadOnlyDatabase: async (work: any) => work() } });
mock.module(new URL('./env.ts', import.meta.url).href, { namedExports: { ENV: { databaseUrl: '', resendApiKey: 'LOCAL-MOCK-ONLY', jwtSecret: 'synthetic' } } });
mock.module(new URL('./adminChangeLogService.ts', import.meta.url).href, { namedExports: { recordAdminMutation: async () => {} } });
mock.module(new URL('./paymentInstructionsConfig.ts', import.meta.url).href, { namedExports: { getReleasedBankTransferInstructions: async () => ({ accounts: [{ labelDe: 'Wise', labelEn: 'Wise', accountHolder: 'SYNTHETIC', iban: 'SYNTHETIC-IBAN', bic: 'SYNTHETIC-BIC' }] }) } });
mock.method(globalThis, 'fetch', async (url: any, options: any) => {
  assert.equal(String(url), 'https://api.resend.com/emails');
  payloads.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ id: 'MOCK-NOT-SENT' }), { status: 200 });
});
process.env.RESEND_API_KEY = 'LOCAL-MOCK-ONLY';
const { communicationTemplateRouter } = await import('./communicationTemplateRouter.js');
const { crmCommunicationRouter } = await import('./crmCommunicationRouter.js');
const { customerRouter } = await import('./customerRouter.js');
const { followUpRouter } = await import('./followUpRouter.js');
const email = await import('./emailService.js');
const { readPersistedOrderMessageData, composeExplicitOrderMessage } = await import('./orderDiscountMessageService.js');
const { buildOrderDiscountMessagePresentation } = await import('./orderDiscountMessagePresentation.js');
const admin: any = { req: { headers: {} }, res: {}, user: { id: 1, name: 'Test', username: 'test', role: 'admin', email: null } };
const marker = (body: string) => (body.match(/order-discount-message\/v1:start|\u2063\u200b\u2063/g) ?? []).length;
const assertCopySafe = (body: string) => assert.doesNotMatch(body, /order-discount-message|follow-up-future-cart|<[^>]*>/i);
after(() => { delete process.env.RESEND_API_KEY; mock.restoreAll(); });

test('32 actual saved order templates plus explicit active custom DE/EN email/WA render one official block', async () => {
  const caller = communicationTemplateRouter.createCaller(admin);
  const before = JSON.stringify(templates);
  for (const template of templates.filter(t => t.templateKey !== 'support_general')) {
    const result = await caller.render({ templateId: template.id, orderId: order.orderId, customerId: 1 });
    assert.equal(result.template.key, template.templateKey);
    assert.equal(result.template.templateKey, template.templateKey);
    assert.equal(result.canonicalOrderId, order.orderId);
    assert.match(result.editableBody, /Custom preserved Ada/);
    assert.equal(marker(result.editableBody), 0);
    assert.equal(marker(result.body), 1);
    assert.equal(marker(result.plainText), 1);
    assert.equal(marker(result.whatsappBody), 1);
    assertCopySafe(result.plainText);
    assertCopySafe(result.whatsappBody);
    assert.ok(result.body.includes(template.language === 'de' ? '56,80 €' : '€56.80'));
    if (template.channel === 'email') assert.equal(marker(result.htmlBody!), 1);
    else { assert.equal(result.htmlBody, null); assert.doesNotMatch(result.whatsappBody, /\*\*/); }
  }
  assert.equal(JSON.stringify(templates), before);
  assert.equal(writes.length, 0);
});

test('support customer-only stays generic and does not read finance; order templates require explicit context; mismatched customer rejected', async () => {
  const caller = communicationTemplateRouter.createCaller(admin);
  for (const template of templates.filter(t => t.templateKey === 'support_general')) {
    reads.length = 0;
    const result = await caller.render({ templateId: template.id, customerId: 1 });
    assert.equal(marker(result.body), 0);
    assert.ok(!reads.includes(schema.orders));
  }
  for (const template of templates.filter(t => families.includes(t.templateKey))) await assert.rejects(() => caller.render({ templateId: template.id, customerId: 1 }), /ausdrücklich auswählen/);
  await assert.rejects(() => caller.render({ templateId: 1, customerId: 2, orderId: order.orderId }), /stimmen nicht überein/);
});

test('readonly CRM preview and manual send recomposition, explicit text, fingerprint conflict and archive replay', async () => {
  const caller = crmCommunicationRouter.createCaller(admin);
  const preview = await caller.previewMessage({ customerId: 1, orderId: order.orderId, channel: 'email', body: '<p>Editable custom</p>', plainText: 'Editable custom', communicationLanguage: 'en' });
  assert.equal(preview.editableBody, '<p>Editable custom</p>');
  assert.match(preview.plainText, /€56\.80/);
  const start = payloads.length;
  await assert.rejects(() => caller.sendEmail({ customerId: 1, orderId: order.orderId, subject: 'Test', htmlBody: preview.htmlBody, financialFingerprint: 'drift', idempotencyKey: 'synthetic-drift' }), (e: any) => e.code === 'CONFLICT');
  assert.equal(payloads.length, start);
  await caller.sendEmail({ customerId: 1, orderId: order.orderId, subject: 'Test', htmlBody: preview.htmlBody, plainText: preview.plainText, communicationLanguage: 'en', financialFingerprint: preview.financialFingerprint, idempotencyKey: 'synthetic-manual-key' });
  const sent = payloads.at(-1);
  assert.equal(marker(sent.html), 1); assert.equal(marker(sent.text), 1);
  assertCopySafe(sent.text);
  const archived = tables.get(schema.customerCommunications)!.at(-1);
  assert.equal(archived.body, sent.text); assert.equal(archived.htmlBody, sent.html);
  await caller.sendEmail({ customerId: 1, orderId: order.orderId, subject: 'Other', htmlBody: '<p>Other</p>', financialFingerprint: 'changed', idempotencyKey: 'synthetic-manual-key' });
  assert.equal(payloads.length, start + 1);
  reads.length = 0;
  const generic = await caller.previewMessage({ customerId: 1, channel: 'whatsapp', body: 'Generic 10% prose' });
  assert.equal(generic.body, 'Generic 10% prose'); assert.ok(!reads.includes(schema.orders));
});

test('persisted DTO serializes final items/raw decimals and no tokens; native DE/EN confirmation packing shipping transport/archive agree', async () => {
  const data = await readPersistedOrderMessageData(db, order.orderId);
  assert.equal(data.orderSnapshot.version, 1); assert.equal(data.orderSnapshot.discount, '68.86');
  assert.equal(data.orderSnapshot.items[0].name, 'Persisted item');
  assert.ok(!JSON.stringify(data.orderSnapshot).includes('Token'));
  for (const language of ['de', 'en'] as const) {
    const emailData = { ...data.emailData, orderId: `SYNTHETIC-${language}`, communicationLanguage: language };
    order.orderId = emailData.orderId; // exact persisted canonical order for neutral transport
    assert.equal(await email.sendOrderConfirmationEmail(emailData), true);
    assert.equal(marker(payloads.at(-1).html), 1); assert.ok(payloads.at(-1).text.includes(language === 'de' ? '56,80 €' : '€56.80'));
    for (const send of [email.sendPackingNotificationEmail, email.sendShippingNotificationEmail]) {
      const result = await send({ orderId: order.orderId, communicationLanguage: language, customerEmail: order.email, customerName: 'Ada', orderDiscountSnapshot: financial, trackingNumber: 'SYNTHETIC-TRACK', trackingCarrier: 'DHL' });
      assert.equal(result.sent, true);
      assert.equal(marker(payloads.at(-1).html), 1); assert.equal(marker(payloads.at(-1).text), 1);
      const archived = tables.get(schema.customerCommunications)!.at(-1); assert.equal(archived.body, payloads.at(-1).text);
      assertCopySafe(payloads.at(-1).text);
      assert.deepEqual(payloads.at(-1).bcc, ['369rebackup@gmail.com']);
    }
  }
  order.orderId = 'SYNTHETIC-1';
});

test('legacy explicit order composes financials; generic remains unchanged; bulk requires explicit offer disclosure and no order lookup', async () => {
  const caller = customerRouter.createCaller(admin);
  await caller.sendEmail({ customerId: 1, orderId: order.orderId, subject: 'Legacy', htmlBody: '<p>Base</p>', plainText: 'Base' });
  assert.equal(marker(payloads.at(-1).html), 1); assert.equal(marker(payloads.at(-1).text), 1);
  const sentCount = payloads.length;
  await assert.rejects(() => caller.sendEmail({ customerId: 2, orderId: order.orderId, subject: 'Mismatch', htmlBody: '<p>Base</p>' }));
  assert.equal(payloads.length, sentCount);
  reads.length = 0;
  await caller.sendEmail({ customerId: 1, subject: 'Generic', htmlBody: '<p>Generic</p>' });
  assert.equal(payloads.at(-1).html, '<p>Generic</p>'); assert.equal(payloads.at(-1).text, undefined); assert.ok(!reads.includes(schema.orders));
  reads.length = 0;
  await caller.sendBulkEmail({ customerIds: [1], subject: 'Campaign', htmlBody: '<p>Offer {{firstName}}</p>', disclosureMode: 'offer', communicationLanguage: 'en' });
  assert.match(payloads.at(-1).html, /cannot yet be determined/); assert.equal(marker(payloads.at(-1).html), 0); assert.ok(!reads.includes(schema.orders));
  await caller.sendBulkEmail({ customerIds: [1], subject: 'Generic', htmlBody: '<p>Generic {{firstName}}</p>' });
  assert.equal(payloads.at(-1).html, '<p>Generic Ada</p>'); assert.equal(payloads.at(-1).text, undefined);
});

test('direct follow-up dispatch adapts old cache once, uses issued code, explicit plain text and unchanged recipient/BCC', async () => {
  const caller = followUpRouter.createCaller(admin);
  await caller.sendFollowUpEmail({ followupId: 1 });
  const sent = payloads.at(-1);
  assert.equal(marker(sent.html), 1); assert.match(sent.text, /Historische Abzüge/); assert.match(sent.text, /noch nicht bestimmbar/);
  assert.match(sent.html, /SYNTHETIC-CODE/); assert.doesNotMatch(sent.html, /\[DISCOUNT_CODE\]|\[ABLAUFDATUM\]/);
  assert.deepEqual(sent.to, [order.email]); assert.deepEqual(sent.bcc, ['369rebackup@gmail.com']);
  assert.equal(followup.emailBody, '<html><body><p>Cached offer [DISCOUNT_CODE], [ABLAUFDATUM]</p></body></html>');
  assert.ok(!writes.some(write => write.table === schema.promoCodes));
});

test('external references canonicalize and customer mismatch is rejected before composing', async () => {
  order.externalOrderReference = 'EXTERNAL-SYNTHETIC';
  const result = await composeExplicitOrderMessage(db, { orderId: order.externalOrderReference, customerId: 1, channel: 'whatsapp', body: 'Base' });
  assert.equal(result.canonicalOrderId, order.orderId);
  assert.equal(result.financialFingerprint, buildOrderDiscountMessagePresentation(order).fingerprint);
  await assert.rejects(() => composeExplicitOrderMessage(db, { orderId: order.orderId, customerId: 2, channel: 'email', body: 'Base' }), /stimmen nicht überein/);
});

test('P4P branch presents one financial block and explicit text in honest existing DE copy with unchanged profile', async () => {
  const data = await readPersistedOrderMessageData(db, order.orderId);
  const p = await email.getOrderConfirmationPresentation({ ...data.emailData, storeKey: 'peps4pets', externalOrderReference: 'P4P-SYNTHETIC', communicationLanguage: 'en' });
  assert.ok(p); assert.equal(marker(p.html), 1); assert.match(p.html, /<html lang="de">/);
  assert.match(p.plainText, /56,80 €/); assert.doesNotMatch(p.html, /YOUR DISCOUNT/);
  assertCopySafe(p.plainText);
  assert.doesNotMatch(p.plainText, /<!--|Header|Order Info|Totals/);
  assert.equal(p.profile?.from, '369 Research <noreply@coreversand.de>');
  assert.equal(await email.getOrderConfirmationPresentation({ ...data.emailData, storeKey: 'peps4pets', externalOrderReference: null }), null);
});

test('follow-up generated and cached bodies recompose once, preserve product copy and do not fabricate next-basket euros', async () => {
  const { generateEmailContent, generateWhatsAppMessage, presentFollowUpContent } = await import('./followUpRouter.js');
  const products = [{ name: 'Preserved product', generatedCopy: 'Existing DE product copy', shopProductId: 'unchanged', sellingPrice: '79.00' }];
  const terms = { discountPercent: 10, codeValidityHours: 48 };
  const wa = generateWhatsAppMessage(order, products, 'ISSUED', new Date('2099-01-01T10:00:00Z'), terms);
  assert.equal(presentFollowUpContent(order, wa, 'whatsapp'), wa);
  const p = generateEmailContent(order, products, 'ISSUED', null, terms);
  assertCopySafe(wa);
  assertCopySafe(p.emailText);
  assert.equal(presentFollowUpContent(order, p.body, 'email'), p.body);
  assert.match(p.emailText, /Existing DE product copy/);
  assert.match(p.emailText, /56,80 €/);
  assert.match(p.emailText, /noch nicht bestimmbar/);
  assert.equal(marker(p.emailText), 0); // native text converter intentionally drops HTML comments
  assert.doesNotMatch(wa, /\*\*/);
  const noFinance = generateWhatsAppMessage({ firstName: 'Ada' }, products, 'FUTURE', null, terms);
  assert.equal(marker(noFinance), 0);
  assert.doesNotMatch(noFinance, /79,00|56,80/);
  assertCopySafe(noFinance);
  assert.equal(presentFollowUpContent({ firstName: 'Ada' }, noFinance, 'whatsapp'), noFinance);
});

test('complete legacy follow-up duplicate markers migrate invisibly and render byte-identically', async () => {
  const { presentFollowUpContent } = await import('./followUpRouter.js');
  const prose = 'Preserved product copy\nhttps://synthetic.invalid/product\nEigener Rabatt 99% = 999€ bleibt redaktionell.';
  const oldFuture = '[follow-up-future-cart:v1:start]\nOld future notice\n[follow-up-future-cart:v1:end]';
  const oldOrder = '[order-discount-message/v1:start]\nOld order figures\n[order-discount-message/v1:end]';
  const oldHtmlFuture = '<!-- follow-up-future-cart:v1:start --><p>Old future notice</p><!-- follow-up-future-cart:v1:end -->';
  const oldHtmlOrder = '<!-- order-discount-message/v1:start --><p>Old order figures</p><!-- order-discount-message/v1:end -->';
  const migrated = presentFollowUpContent(order, `${prose}\n\n${oldFuture}\n\n${oldOrder}\n\n${oldHtmlFuture}\n\n${oldHtmlOrder}\n\n${oldFuture}`, 'whatsapp');
  assert.equal(migrated, presentFollowUpContent(order, prose, 'whatsapp'));
  assert.equal(presentFollowUpContent(order, migrated, 'whatsapp'), migrated);
  assert.equal(marker(migrated), 1);
  assert.equal((migrated.match(/noch nicht bestimmbar/g) ?? []).length, 1);
  assertCopySafe(migrated);
  assert.doesNotMatch(migrated, /\bstart\b|\bend\b|Old future notice|Old order figures|[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/i);
  assert.ok(migrated.startsWith(prose));
});

test('CRM preview preserves admin-only permission and failed/draft archive replay never calls provider', async () => {
  for (const role of [null, 'packing', 'product_manager']) {
    const context = { ...admin, user: role ? { ...admin.user, role } : null };
    await assert.rejects(() => crmCommunicationRouter.createCaller(context).previewMessage({ channel: 'whatsapp', body: 'Generic' }), /anmelden|Berechtigung/);
  }
  const archive = tables.get(schema.customerCommunications)!;
  const count = payloads.length;
  for (const status of ['failed', 'draft']) {
    archive.push({ id: archive.length + 1, status, idempotencyKey: `synthetic-${status}`, errorMessage: 'Preserved status' });
    await assert.rejects(() => crmCommunicationRouter.createCaller(admin).sendEmail({ customerId: 1, subject: 'Replay', htmlBody: '<p>Replay</p>', idempotencyKey: `synthetic-${status}` }), /Preserved status/);
  }
  assert.equal(payloads.length, count);
});
