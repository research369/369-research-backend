import { z } from 'zod';

// Closed local list of known ISO 13616 country lengths. Unknown countries fail
// closed; no bank lookup/network request and no claim of holder verification.
export const IBAN_COUNTRY_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD:24, AE:23, AL:28, AT:20, AZ:28, BA:20, BE:16, BG:22, BH:22,
  BR:29, BY:28, CH:21, CR:22, CY:28, CZ:24, DE:22, DK:18, DO:28,
  EE:20, EG:29, ES:24, FI:18, FO:18, FR:27, GB:22, GE:22, GI:23,
  GL:18, GR:27, GT:28, HR:21, HU:28, IE:22, IL:23, IS:26, IT:27,
  IQ:23, JO:30, KW:30, KZ:20, LB:28, LC:32, LI:21, LT:20, LU:20,
  LV:21, MC:27, MD:24, ME:22, MK:19, MR:27, MT:31, MU:30, NL:18,
  NO:15, PK:24, PL:28, PS:29, PT:25, QA:29, RO:24, RS:22, SA:24,
  SC:31, SE:24, SI:19, SK:24, SM:27, ST:25, SV:28, TL:23, TN:24,
  TR:26, UA:29, VA:22, VG:24, XK:20,
});
// Additional BBAN structure checks for the common supported country formats.
// Remaining known countries still require their exact length + alphanumeric
// ISO envelope + MOD-97 checksum. National account checksums are not verified.
const BBAN_FORMATS: Readonly<Record<string, RegExp>> = Object.freeze({
  AD:/^\d{8}[A-Z0-9]{12}$/, AT:/^\d{16}$/, BA:/^\d{16}$/, BE:/^\d{12}$/,
  BG:/^[A-Z]{4}\d{6}[A-Z0-9]{8}$/, CH:/^\d{5}[A-Z0-9]{12}$/,
  CY:/^\d{8}[A-Z0-9]{16}$/, CZ:/^\d{20}$/, DE:/^\d{18}$/,
  DK:/^\d{14}$/, EE:/^\d{16}$/, ES:/^\d{20}$/, FI:/^\d{14}$/,
  FO:/^\d{14}$/, FR:/^\d{10}[A-Z0-9]{11}\d{2}$/,
  GB:/^[A-Z]{4}\d{14}$/, GI:/^[A-Z]{4}[A-Z0-9]{15}$/, GL:/^\d{14}$/,
  GR:/^\d{7}[A-Z0-9]{16}$/, HR:/^\d{17}$/, HU:/^\d{24}$/,
  IE:/^[A-Z]{4}\d{14}$/, IL:/^\d{19}$/, IS:/^\d{22}$/,
  IT:/^[A-Z]\d{10}[A-Z0-9]{12}$/, LI:/^\d{5}[A-Z0-9]{12}$/,
  LT:/^\d{16}$/, LU:/^\d{3}[A-Z0-9]{13}$/, LV:/^[A-Z]{4}[A-Z0-9]{13}$/,
  MC:/^\d{10}[A-Z0-9]{11}\d{2}$/, ME:/^\d{18}$/, MK:/^\d{3}[A-Z0-9]{10}\d{2}$/,
  MT:/^[A-Z]{4}\d{5}[A-Z0-9]{18}$/, NL:/^[A-Z]{4}\d{10}$/,
  NO:/^\d{11}$/, PL:/^\d{24}$/, PT:/^\d{21}$/,
  RO:/^[A-Z]{4}[A-Z0-9]{16}$/, RS:/^\d{18}$/, SE:/^\d{20}$/,
  SI:/^\d{15}$/, SK:/^\d{20}$/, SM:/^[A-Z]\d{10}[A-Z0-9]{12}$/,
  TN:/^\d{20}$/, TR:/^\d{5}[A-Z0-9]{17}$/, VA:/^\d{18}$/, XK:/^\d{16}$/,
});
export function normalizePartnerIban(value: string): string {
  return value.replace(/ /g, '').toUpperCase();
}
export function isValidPartnerIban(value: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(value)) return false;
  const country = value.slice(0, 2);
  if (IBAN_COUNTRY_LENGTHS[country] !== value.length) return false;
  const format = BBAN_FORMATS[country];
  if (format && !format.test(value.slice(4))) return false;
  let remainder = 0;
  for (const character of value.slice(4) + value.slice(0, 4)) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
const holder = z.string().max(200).refine(value => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value), 'BANK_INPUT_INVALID')
  .transform(value => value.trim()).pipe(z.string().min(2).max(150));
const iban = z.string().min(1).max(100).regex(/^[A-Za-z0-9 ]+$/, 'BANK_INPUT_INVALID')
  .transform(normalizePartnerIban).refine(isValidPartnerIban, 'BANK_INPUT_INVALID');
const bic = z.string().max(30).refine(value => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value), 'BANK_INPUT_INVALID')
  .transform(value => value.trim().toUpperCase())
  .refine(value => value === '' || /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(value), 'BANK_INPUT_INVALID');
export const partnerBankSaveInput = z.object({
  accountHolder: holder,
  iban,
  bic: bic.optional(),
  version: z.number().int().min(0).max(2147483647),
  // Never trim a password or include it in a validation error/cause.
  currentPassword: z.string().min(1).max(256),
}).strict();
export const partnerBankAdminGetInput = z.object({ partnerId: z.number().int().positive().max(2147483647) }).strict();
export const partnerBankMineInput = z.undefined();
export type PartnerBankSaveInput = z.infer<typeof partnerBankSaveInput>;
export interface PartnerBankAccount { accountHolder: string; iban: string; bic: string | null }
export interface PartnerBankSnapshot { version: number; updatedAt: string | null; bankAccount: PartnerBankAccount | null }
export function bankAccountFromInput(input: PartnerBankSaveInput): PartnerBankAccount {
  return { accountHolder: input.accountHolder, iban: input.iban, bic: input.bic || null };
}
export function sameBankAccount(left: PartnerBankAccount, right: PartnerBankAccount): boolean {
  return left.accountHolder === right.accountHolder && left.iban === right.iban && left.bic === right.bic;
}
