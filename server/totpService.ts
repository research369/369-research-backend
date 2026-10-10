import * as OTPAuth from "otpauth";

export const TOTP_ISSUER = "369 Research WaWi";
export const TOTP_ALGORITHM = "SHA1";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_VALIDATION_WINDOW = 1;

const TOTP_CODE_PATTERN = new RegExp(`^\\d{${TOTP_DIGITS}}$`);

function createTotp(secret: OTPAuth.Secret, label: string) {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret,
  });
}

export function createTotpSetup(username: string) {
  const totp = createTotp(new OTPAuth.Secret({ size: 20 }), username);
  return {
    secret: totp.secret.base32,
    otpAuthUrl: totp.toString(),
  };
}

export function verifyTotpToken(secret: string, code: string, timestamp = Date.now()): boolean {
  if (!secret || !TOTP_CODE_PATTERN.test(code)) return false;

  try {
    const totp = createTotp(OTPAuth.Secret.fromBase32(secret), "user");
    return totp.validate({
      token: code,
      window: TOTP_VALIDATION_WINDOW,
      timestamp,
    }) !== null;
  } catch {
    return false;
  }
}

export function canStartTotpSetup(totpEnabled: number | boolean): boolean {
  return !totpEnabled;
}
