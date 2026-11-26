import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePartnerCodeTerms } from './partnerProgramService.js';
const term = (code: string) => ({ code, commissionPercent: 10, customerDiscountPercent: 10 });
test('new manual partner codes are at most 16 characters and have no BEN branding prefix', () => {
  assert.equal(normalizePartnerCodeTerms([term('DANIEL10')])[0].code, 'DANIEL10');
  assert.equal(normalizePartnerCodeTerms([term('ABCDEFGHIJKLMN10')])[0].code.length, 16);
  assert.throws(() => normalizePartnerCodeTerms([term('ABCDEFGHIJKLMNO10')]), /maximal 16/);
  assert.throws(() => normalizePartnerCodeTerms([term('BEN-DANIEL10')]), /BEN-Präfix/);
});
test('existing long/prefixed code remains editable without silently disabling other partners', () => {
  const legacy = 'BEN-DANIELKREISMANN10-62E3CE90B458';
  assert.equal(normalizePartnerCodeTerms([term(legacy)], [legacy])[0].code, legacy);
  assert.throws(() => normalizePartnerCodeTerms([term(legacy)], ['OTHER10']), /maximal 16/);
});
