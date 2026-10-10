import assert from "node:assert/strict";
import test from "node:test";
import * as OTPAuth from "otpauth";
import {
  TOTP_PERIOD_SECONDS,
  TOTP_VALIDATION_WINDOW,
  canStartTotpSetup,
  verifyTotpToken,
} from "./totpService.js";

const SECRET = "JBSWY3DPEHPK3PXP";
const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);

function codeAt(timestamp: number) {
  const totp = new OTPAuth.TOTP({
    issuer: "Test",
    label: "test",
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(SECRET),
  });
  return totp.generate({ timestamp });
}

test("accepts the current and immediately previous TOTP time step only", () => {
  assert.equal(TOTP_VALIDATION_WINDOW, 1);
  assert.equal(verifyTotpToken(SECRET, codeAt(NOW), NOW), true);
  assert.equal(verifyTotpToken(SECRET, codeAt(NOW - TOTP_PERIOD_SECONDS * 1_000), NOW), true);
  assert.equal(verifyTotpToken(SECRET, codeAt(NOW - TOTP_PERIOD_SECONDS * 2_000), NOW), false);
});

test("rejects malformed input and malformed secrets without throwing", () => {
  assert.equal(verifyTotpToken(SECRET, "12 345", NOW), false);
  assert.equal(verifyTotpToken(SECRET, "abcdef", NOW), false);
  assert.equal(verifyTotpToken("not-a-base32-secret", codeAt(NOW), NOW), false);
});

test("does not allow setup to replace an active authenticator key", () => {
  assert.equal(canStartTotpSetup(0), true);
  assert.equal(canStartTotpSetup(false), true);
  assert.equal(canStartTotpSetup(1), false);
  assert.equal(canStartTotpSetup(true), false);
});
