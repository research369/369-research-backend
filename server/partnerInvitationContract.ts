import { createHash, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
export const BEN_INVITATION_INFO = Object.freeze({
  enabled: true, inviter: 'Ben', title: 'CEO', customerDiscountPercent: 10,
  commissionPercent: 10, settlementMethod: 'payout', requiresApproval: true,
  termsVersion: 'ben-10-10-v1',
} as const);
// Client must use crypto.randomUUID() or 32+ cryptographically random safe characters.
// Secrets are never accepted in query strings, logged, or returned by this module.
export const registrationKeyInput = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const partnerInvitationSubmitInput = z.object({
  registrationKey: registrationKeyInput,
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().toLowerCase().email().max(320),
  phone: z.string().trim().min(3).max(60),
  company: z.string().trim().max(200).optional(),
  password: z.string().min(10).max(100).refine(value => Buffer.byteLength(value, 'utf8') <= 72,
    'Passwort darf höchstens 72 UTF-8-Bytes enthalten (bcrypt).'),
  passwordConfirm: z.string().min(10).max(100).optional(),
  agreeToTerms: z.literal(true),
  termsVersion: z.literal(BEN_INVITATION_INFO.termsVersion),
  website: z.literal(''),
}).strict().refine(value => value.passwordConfirm === undefined || value.passwordConfirm === value.password,
  { path: ['passwordConfirm'], message: 'Passwörter stimmen nicht überein.' });
export const partnerInvitationStatusInput = z.object({ registrationKey: registrationKeyInput }).strict();
export const partnerInvitationReviewInput = z.object({ id: z.number().int().positive() }).strict();
export type PartnerInvitationSubmit = z.infer<typeof partnerInvitationSubmitInput>;
export type InvitationStatus = { status: 'pending' | 'rejected' } | { status: 'approved'; partnerNumber: string; code: string };
export function invitationKeyHash(key: string): string {
  return createHash('sha256').update(`369:partner-invitation:ben:v1:${key}`).digest('hex');
}
export function newInvitationIdentifiers(name: string, attempt = 0): { code: string; partnerNumber: string } {
  const firstName = name.trim().split(/\s+/u)[0];
  const safeName = firstName.normalize('NFKD').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'PARTNER';
  // The primary name10 candidate is readable; collision retries get four unbiased random characters.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const suffix = attempt > 0 ? Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('') : '';
  return { code: `${safeName}10${suffix}`,
    partnerNumber: `P-${randomBytes(8).toString('hex').toUpperCase()}` };
}
