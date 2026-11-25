import assert from 'node:assert/strict';
import test, { beforeEach, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { partnerBankSaveInput, partnerBankAdminGetInput, partnerBankMineInput, bankAccountFromInput, isValidPartnerIban, normalizePartnerIban, sameBankAccount, IBAN_COUNTRY_LENGTHS } from './partnerBankingContract.js';
import { assertPartnerBankKey, encryptPartnerBankAccount, decryptPartnerBankAccount } from './partnerBankingCrypto.js';

const originalJwt = process.env.JWT_SECRET; const originalOverride = process.env.PARTNER_BANK_DATA_KEY;
const fixtureKey = 'synthetic-local-banking-jwt-only-never-live';
beforeEach(() => { process.env.JWT_SECRET = fixtureKey; delete process.env.PARTNER_BANK_DATA_KEY; });
after(() => {
  if (originalJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalJwt;
  if (originalOverride === undefined) delete process.env.PARTNER_BANK_DATA_KEY; else process.env.PARTNER_BANK_DATA_KEY = originalOverride;
});
const valid = { accountHolder: 'Synthetic Holder', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', version: 0, currentPassword: 'Synthetic-password-123' };
const account = () => bankAccountFromInput(partnerBankSaveInput.parse(valid));
function ibanWithChecksum(country: string, bban: string): string {
  let mod = 0;
  for (const char of bban + country + '00') {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) mod = (mod * 10 + Number(digit)) % 97;
  }
  return country + String(98 - mod).padStart(2, '0') + bban;
}

test('strict exact save/admin/mine schemas reject unknown ownership/secret fields and invalid versions', () => {
  assert(partnerBankSaveInput.safeParse(valid).success);
  for (const patch of [{ partnerId: 2 }, { actor: 'admin' }, { version: -1 }, { version: 1.5 }, { version: NaN }, { version: 2147483648 }, { currentPassword: '' }, { currentPassword: 'a'.repeat(257) }]) assert(!partnerBankSaveInput.safeParse({ ...valid, ...patch }).success);
  assert(!partnerBankAdminGetInput.safeParse({ partnerId: 1, secret: true }).success);
  for (const partnerId of [0, -1, 1.2, '1', Infinity]) assert(!partnerBankAdminGetInput.safeParse({ partnerId }).success);
  assert(partnerBankMineInput.safeParse(undefined).success);
  for (const input of [{}, null, { partnerId: 1 }]) assert(!partnerBankMineInput.safeParse(input).success);
});
test('IBAN normalizes ONLY ASCII spaces/case and accepted input keeps password literal', () => {
  const parsed = partnerBankSaveInput.parse({ ...valid, accountHolder: '  Synthetic Holder  ', iban: ' de89 3704 0044 0532 0130 00 ', bic: ' cobadeffxxx ', currentPassword: ' untrimmed ' });
  assert.equal(parsed.accountHolder, valid.accountHolder); assert.equal(parsed.iban, valid.iban); assert.equal(parsed.bic, valid.bic); assert.equal(parsed.currentPassword, ' untrimmed ');
  assert.equal(normalizePartnerIban('de89 3704'), 'DE893704');
});
test('missing/blank BIC becomes null; 8/11 ISO 9362 permitted; malformed BIC rejected', () => {
  for (const bic of [undefined, '', '   ']) assert.equal(bankAccountFromInput(partnerBankSaveInput.parse({ ...valid, bic })).bic, null);
  for (const bic of ['COBADEFF', 'COBADEFFXXX', 'cobadeff']) assert(partnerBankSaveInput.safeParse({ ...valid, bic }).success);
  for (const bic of ['COBADEFFF', '1234DEFF', 'COBA12FF', 'COBADE!!', 'COBA DEFF', 'COBADEFF\n', 'COBADEFFXXXX']) assert(!partnerBankSaveInput.safeParse({ ...valid, bic }).success);
});
test('holder requires 2-150 trimmed non-control characters including unicode/international names', () => {
  for (const accountHolder of ['Éva Müller', '李明', 'AB', 'A'.repeat(150)]) assert(partnerBankSaveInput.safeParse({ ...valid, accountHolder }).success);
  for (const accountHolder of ['', 'A', '   ', 'A'.repeat(151), 'Holder\nName', 'Holder\u0000Name', 'Holder\u007fName', 'Holder\u200bName', '\nHolder', 'Holder\ud800']) assert(!partnerBankSaveInput.safeParse({ ...valid, accountHolder }).success);
});
test('MOD-97, recognized country/exact length and envelope enforced; tabs/non-ASCII whitespace rejected', () => {
  for (const iban of ['DE89370400440532013001', 'DE8937040044053201300', 'XX89370400440532013000', '1239370400440532013000', 'DE89\t370400440532013000', 'DE89\n370400440532013000', 'DE89\u00a0370400440532013000', 'DE89-370400440532013000']) assert(!partnerBankSaveInput.safeParse({ ...valid, iban }).success);
  assert(Object.keys(IBAN_COUNTRY_LENGTHS).length > 70);
});
test('known common international IBAN examples validate without external service', () => {
  for (const iban of ['GB82WEST12345698765432', 'FR1420041010050500013M02606', 'NL91ABNA0417164300', 'ES9121000418450200051332', 'AT611904300234573201', 'CH9300762011623852957', 'BE68539007547034', 'IT60X0542811101000000123456', 'NO9386011117947']) assert(isValidPartnerIban(iban), iban.slice(0,2));
});
test('valid MOD-97 alone cannot bypass numeric/common national BBAN formats', () => {
  const wrongFormat = ibanWithChecksum('DE', 'A'.repeat(18));
  assert(!isValidPartnerIban(wrongFormat));
  assert(!isValidPartnerIban(ibanWithChecksum('GB', '1'.repeat(18))));
  assert(!isValidPartnerIban(ibanWithChecksum('ZZ', '1'.repeat(18))));
});
test('account equality requires exact holder/IBAN/nullable BIC', () => {
  assert(sameBankAccount(account(), account()));
  for (const patch of [{ accountHolder: 'Different Holder' }, { iban: 'GB82WEST12345698765432' }, { bic: null }]) assert(!sameBankAccount(account(), { ...account(), ...patch }));
});
test('AES-256-GCM roundtrip supports nullable BIC, encrypted payload has no clear values', () => {
  for (const bic of [valid.bic, null]) {
    const data = { ...account(), bic }; const payload = encryptPartnerBankAccount(data, 1, 1);
    assert.deepEqual(decryptPartnerBankAccount(payload, 1, 1), data);
    for (const secret of [valid.iban, valid.accountHolder, valid.currentPassword, fixtureKey]) assert(!payload.includes(secret));
    const [format, iv, tag] = payload.split('.'); assert.equal(format, 'v1'); assert.equal(Buffer.from(iv, 'base64url').length, 12); assert.equal(Buffer.from(tag, 'base64url').length, 16);
  }
});
test('random IV generates distinct ciphertext for same clear account/row/version', () => {
  const payloads = new Set(Array.from({ length: 20 }, () => encryptPartnerBankAccount(account(), 1, 1)));
  assert.equal(payloads.size, 20);
});
test('AAD partnerId/version binds rows and rejects swapping/replay across versions', () => {
  const payload = encryptPartnerBankAccount(account(), 1, 1);
  for (const [id, version] of [[2,1], [1,2], [0,1], [1,0], [-1,1], [1,1.5]]) assert.throws(() => decryptPartnerBankAccount(payload, id, version), /BANK_PAYLOAD_INVALID/);
});
test('IV, authentication tag and ciphertext tamper all reject generically', () => {
  const payload = encryptPartnerBankAccount(account(), 1, 1);
  for (const index of [1,2,3]) {
    const parts = payload.split('.'); const buffer = Buffer.from(parts[index], 'base64url'); buffer[0] ^= 1; parts[index] = buffer.toString('base64url');
    assert.throws(() => decryptPartnerBankAccount(parts.join('.'), 1, 1), /^Error: BANK_PAYLOAD_INVALID$/);
  }
});
test('malformed/truncated/oversized ciphertext envelopes fail closed generically', () => {
  for (const payload of ['', 'v0.x.x.x', 'v1.a.a.a', 'v1.!.a.a', 'v1.a.a.a.extra', `v1.${randomBytes(12).toString('base64url')}.${randomBytes(16).toString('base64url')}.${randomBytes(2049).toString('base64url')}`]) assert.throws(() => decryptPartnerBankAccount(payload, 1, 1), /^Error: BANK_PAYLOAD_INVALID$/);
});
test('missing/short/development/default/repeated JWT fail closed even with strong override', () => {
  for (const secret of [undefined, '', 'short', 'dev-secret-change-me'.repeat(2), 'fallback-key'.repeat(4), 'a'.repeat(64)]) {
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    assert.throws(assertPartnerBankKey, /BANK_KEY_UNAVAILABLE/);
    process.env.PARTNER_BANK_DATA_KEY = 'synthetic-independent-strong-banking-key';
    assert.throws(assertPartnerBankKey, /BANK_KEY_UNAVAILABLE/); delete process.env.PARTNER_BANK_DATA_KEY;
  }
});
test('optional override purpose-derived key works; weak explicit override cannot fallback', () => {
  process.env.PARTNER_BANK_DATA_KEY = 'synthetic-independent-strong-banking-key';
  const payload = encryptPartnerBankAccount(account(), 1, 1); assert.deepEqual(decryptPartnerBankAccount(payload, 1, 1), account());
  delete process.env.PARTNER_BANK_DATA_KEY; assert.throws(() => decryptPartnerBankAccount(payload, 1, 1), /BANK_PAYLOAD_INVALID/);
  for (const key of ['', 'short', 'dev-secret-change-me'.repeat(3)]) { process.env.PARTNER_BANK_DATA_KEY = key; assert.throws(assertPartnerBankKey, /BANK_KEY_UNAVAILABLE/); }
});
test('changing selected key rejects existing data; JWT change does not change independently keyed encryption', () => {
  const payload = encryptPartnerBankAccount(account(), 1, 1);
  process.env.JWT_SECRET = 'another-local-banking-jwt-secret-never-live';
  assert.throws(() => decryptPartnerBankAccount(payload, 1, 1), /BANK_PAYLOAD_INVALID/);
  process.env.PARTNER_BANK_DATA_KEY = 'synthetic-independent-strong-banking-key';
  const separate = encryptPartnerBankAccount(account(), 1, 1);
  process.env.JWT_SECRET = fixtureKey; assert.deepEqual(decryptPartnerBankAccount(separate, 1, 1), account());
});
test('bank migration only creates additive tables/index and cascade deletion never blocks existing deletion', () => {
  const sql = readFileSync(new URL('../drizzle/migrations/0036_partner_bank_accounts.sql', import.meta.url), 'utf8');
  assert(!/^\s*(?:UPDATE|DELETE|TRUNCATE|ALTER TABLE)\b/im.test(sql)); assert.match(sql, /partner_id INTEGER PRIMARY KEY REFERENCES partners\(id\) ON DELETE CASCADE/);
  assert(!/\b(?:iban|account_holder|password_hash)\b/i.test(sql));
  const schema = readFileSync(new URL('./partnerBankingSchema.ts', import.meta.url), 'utf8');
  assert(schema.indexOf('await readFile(') > schema.indexOf('readiness = (async () =>'));
});
