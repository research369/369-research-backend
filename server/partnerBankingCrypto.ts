import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { partnerBankSaveInput, bankAccountFromInput, type PartnerBankAccount } from './partnerBankingContract.js';

const PURPOSE = '369:partner-bank-accounts:aes-256-gcm:v1';
function strongSecret(value: string | undefined): string {
  if (!value || Buffer.byteLength(value, 'utf8') < 32 || /^(dev|development|changeme|secret)$|dev-secret|fallback/i.test(value)
    || /^(.)\1+$/.test(value)) throw Error('BANK_KEY_UNAVAILABLE');
  return value;
}
/** Never use ENV's development fallback. A weak explicit override fails closed.
 * Stable key material is operationally required; changing either selected key
 * without a separate reviewed re-encryption loses access to existing ciphertext.
 */
function bankKey(): Buffer {
  const jwt = strongSecret(process.env.JWT_SECRET);
  const selected = process.env.PARTNER_BANK_DATA_KEY === undefined ? jwt : strongSecret(process.env.PARTNER_BANK_DATA_KEY);
  return Buffer.from(hkdfSync('sha256', selected, '369:partner-banking:hkdf-salt:v1', PURPOSE, 32));
}
export function assertPartnerBankKey(): void { const key = bankKey(); key.fill(0); }
function associatedData(partnerId: number, version: number): Buffer {
  if (!Number.isSafeInteger(partnerId) || partnerId < 1 || !Number.isSafeInteger(version) || version < 1) throw Error('BANK_PAYLOAD_INVALID');
  return Buffer.from(`${PURPOSE}:partner:${partnerId}:version:${version}`);
}
export function encryptPartnerBankAccount(account: PartnerBankAccount, partnerId: number, version: number): string {
  const key = bankKey();
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(associatedData(partnerId, version));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(account), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  } catch { throw Error('BANK_PAYLOAD_INVALID'); }
  finally { key.fill(0); }
}
export function decryptPartnerBankAccount(payload: string, partnerId: number, version: number): PartnerBankAccount {
  const key = bankKey();
  try {
    const [format, ivText, tagText, cipherText, extra] = payload.split('.');
    if (format !== 'v1' || extra !== undefined || ![ivText, tagText, cipherText].every(value => value && /^[A-Za-z0-9_-]+$/.test(value))) throw Error();
    const iv = Buffer.from(ivText, 'base64url'); const tag = Buffer.from(tagText, 'base64url');
    const ciphertext = Buffer.from(cipherText, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1 || ciphertext.length > 2048) throw Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(associatedData(partnerId, version)); decipher.setAuthTag(tag);
    const clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    let data: unknown;
    try { data = JSON.parse(clear.toString('utf8')); } finally { clear.fill(0); }
    // Strict, canonical payload validation; never surface parser issues or values.
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    const object = data as Record<string, unknown>;
    if (Object.keys(object).sort().join(',') !== 'accountHolder,bic,iban' || (object.bic !== null && typeof object.bic !== 'string')) throw Error();
    const parsed = partnerBankSaveInput.safeParse({ ...object, bic: object.bic === null ? undefined : object.bic, version: 0, currentPassword: 'payload-validation-only' });
    if (!parsed.success) throw Error();
    const account = bankAccountFromInput(parsed.data);
    if (account.accountHolder !== object.accountHolder || account.iban !== object.iban || account.bic !== object.bic) throw Error();
    return account;
  } catch { throw Error('BANK_PAYLOAD_INVALID'); }
  finally { key.fill(0); }
}
