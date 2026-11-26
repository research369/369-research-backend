import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { BEN_INVITATION_INFO, partnerInvitationSubmitInput, partnerInvitationStatusInput, partnerInvitationReviewInput, invitationKeyHash, newInvitationIdentifiers } from './partnerInvitationContract.js';
const valid = () => ({ registrationKey: randomUUID(), name: ' Synthetic Owner ', email: ' SYNTHETIC@fixture.invalid ', phone: ' +49000000 ', password: 'Synthetic-password-123', agreeToTerms: true as const, termsVersion: 'ben-10-10-v1' as const, website: '' as const });
test('public info contains only fixed invitation terms, no PII, and is immutable', () => {
  assert.deepEqual(BEN_INVITATION_INFO, { enabled: true, inviter: 'Ben', title: 'CEO', customerDiscountPercent: 10, commissionPercent: 10, settlementMethod: 'payout', requiresApproval: true, termsVersion: 'ben-10-10-v1' });
  assert(Object.isFrozen(BEN_INVITATION_INFO));
});
test('strict schema normalizes identity and accepts optional company/confirmation', () => {
  const input = partnerInvitationSubmitInput.parse({ ...valid(), company: ' Example ', passwordConfirm: 'Synthetic-password-123' });
  assert.equal(input.name, 'Synthetic Owner'); assert.equal(input.email, 'synthetic@fixture.invalid');
  assert.equal(input.phone, '+49000000'); assert.equal(input.company, 'Example');
  assert(partnerInvitationSubmitInput.safeParse({ ...valid(), phone: '1'.repeat(60) }).success);
  assert(partnerInvitationSubmitInput.safeParse({ ...valid(), password: 'a'.repeat(72) }).success);
});
test('all client commercial/program/status/code/account overrides fail closed', () => {
  for (const key of ['customerDiscountPercent', 'commissionPercent', 'programKey', 'program_key', 'settlementMethod', 'status', 'code', 'codes', 'partnerNumber', 'partnerId', 'isActive', 'passwordHash', 'creditBalance']) {
    assert.equal(partnerInvitationSubmitInput.safeParse({ ...valid(), [key]: 'override' }).success, false, key);
  }
  assert.equal(partnerInvitationStatusInput.safeParse({ registrationKey: randomUUID(), email: 'other@fixture.invalid' }).success, false);
  assert.equal(partnerInvitationReviewInput.safeParse({ id: 1, commissionPercent: 99 }).success, false);
});
test('identity, key, consent, terms, honeypot and password boundaries are enforced', () => {
  for (const patch of [{ name: 'a' }, { name: 'a'.repeat(151) }, { email: 'invalid' }, { phone: '12' }, { phone: '1'.repeat(61) }, { company: 'a'.repeat(201) }, { registrationKey: 'guess' }, { registrationKey: ' '.repeat(36) }, { password: 'short' }, { password: 'a'.repeat(101) }, { password: 'ä'.repeat(37) }, { passwordConfirm: 'not-the-password' }, { agreeToTerms: false }, { termsVersion: 'old' }, { website: 'bot.invalid' }]) {
    assert.equal(partnerInvitationSubmitInput.safeParse({ ...valid(), ...patch }).success, false, JSON.stringify(Object.keys(patch)));
  }
});
test('registration lookup hashes are deterministic, domain separated, never plaintext', () => {
  const key = randomUUID(); const hash = invitationKeyHash(key);
  assert.match(hash, /^[a-f0-9]{64}$/); assert.equal(hash, invitationKeyHash(key));
  assert.notEqual(hash, invitationKeyHash(randomUUID())); assert(!hash.includes(key));
});
test('primary codes use only the first name segment, NFKD uppercase ASCII and trailing 10', () => {
  const cases = [
    ['Daniel Müller', 'DANIEL10'],
    ['  Daniel  Alexander Müller  ', 'DANIEL10'],
    ['Anna Maria Schmidt', 'ANNA10'],
    ['Anna-Maria Schmidt', 'ANNAMARIA10'],
    ['\tÄda\nLovelace', 'ADA10'],
    ['Élodie Dupont', 'ELODIE10'],
    ['Jose\u0301 Alvarez', 'JOSE10'],
    ['A\u1ab0da Lovelace', 'ADA10'],
    ['Özil Yılmaz', 'OZIL10'],
    ['Straße Example', 'STRASSE10'],
    ['Jean-Luc Picard', 'JEANLUC10'],
    ['D’Angelo Example', 'DANGELO10'],
    ['Ｄａｎｉｅｌ\u3000Müller', 'DANIEL10'],
    ['１２３abc Last', '123ABC10'],
    ['ﬃona Last', 'FFIONA10'],
    ['Abcdefghijklmnopqrstuvwxyz Last', 'ABCDEFGHIJ10'],
    ['Ben Example', 'BEN10'],
    ['漢字 Daniel', 'PARTNER10'],
    ['Иван Иванов', 'PARTNER10'],
    ['--- Daniel', 'PARTNER10'],
    ['', 'PARTNER10'],
    [' \t\n ', 'PARTNER10'],
  ];
  for (const [name, expected] of cases) {
    const { code, partnerNumber } = newInvitationIdentifiers(name);
    assert.equal(code, expected, name);
    assert.match(code, /^[A-Z0-9]{1,10}10$/); assert(code.length <= 16);
    assert(!code.startsWith('BEN-')); assert.match(partnerNumber, /^P-[A-F0-9]{16}$/);
  }
});
test('default and explicit attempt zero keep the same readable primary code across duplicate first names', () => {
  assert.equal(newInvitationIdentifiers('Daniel Müller').code, 'DANIEL10');
  assert.equal(newInvitationIdentifiers('Daniel Schmidt', 0).code, 'DANIEL10');
  assert.equal(newInvitationIdentifiers('Daniel Alexander Müller').code, 'DANIEL10');
});
test('collision attempts add four cryptographically random uppercase alphanumeric characters within 16', () => {
  for (const name of ['Daniel Müller', 'Abcdefghijklmnopqrstuvwxyz Last', '漢字']) {
    const primary = newInvitationIdentifiers(name).code;
    const seen = new Set([primary]);
    for (let attempt = 1; attempt < 10; attempt++) {
      const { code, partnerNumber } = newInvitationIdentifiers(name, attempt);
      assert(code.startsWith(primary)); assert.match(code.slice(primary.length), /^[A-Z0-9]{4}$/);
      assert.match(code, /^[A-Z0-9]{1,16}$/); assert(!code.startsWith('BEN-'));
      assert(!seen.has(code)); seen.add(code); assert.match(partnerNumber, /^P-[A-F0-9]{16}$/);
    }
  }
  assert.notEqual(newInvitationIdentifiers('Daniel', 1).code, newInvitationIdentifiers('Daniel', 1).code);
});
test('partner numbers always use a neutral prefix and a fresh 64-bit uppercase hexadecimal value', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const { partnerNumber } = newInvitationIdentifiers('Daniel Müller', i % 10);
    assert.match(partnerNumber, /^P-[A-F0-9]{16}$/); assert(!partnerNumber.startsWith('BEN-'));
    assert(!seen.has(partnerNumber)); seen.add(partnerNumber);
  }
});
