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
test('server identifiers use random BEN namespace, name10 and safe bounded characters', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { code, partnerNumber } = newInvitationIdentifiers(' Äda / long! name 漢字 ');
    assert.match(code, /^BEN-ADALONGNAME10-[A-F0-9]{12}$/); assert(code.length <= 50);
    assert.match(partnerNumber, /^BEN-[A-F0-9]{16}$/); assert(!seen.has(code)); seen.add(code);
  }
  assert.match(newInvitationIdentifiers('漢字').code, /^BEN-PARTNER10-/);
});
