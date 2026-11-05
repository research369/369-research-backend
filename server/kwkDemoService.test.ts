import assert from "node:assert/strict";
import test from "node:test";
import {
  createKwkDemoToken,
  createKwkToken,
  verifyKwkDemoToken,
  verifyKwkToken,
} from "./kwkAuth.js";
import { verifyToken } from "./auth.js";
import {
  isKwkDemoReference,
  normalizeKwkDemoEmail,
} from "./kwkDemoService.js";

test("keeps demo email identity canonical and references visibly isolated", () => {
  assert.equal(normalizeKwkDemoEmail("  PakkoRandale@GMAIL.COM  "), "pakkorandale@gmail.com");
  assert.equal(isKwkDemoReference("DEMO-KWK-001"), true);
  assert.equal(isKwkDemoReference("369-11258"), false);
});

test("never accepts a demo token as a productive KWK token and vice versa", () => {
  const demoToken = createKwkDemoToken(42);
  const liveToken = createKwkToken(42);

  assert.deepEqual(verifyKwkDemoToken(demoToken), { demoAccountId: 42 });
  assert.equal(verifyKwkToken(demoToken), null);
  assert.equal(verifyToken(demoToken), null);
  assert.deepEqual(verifyKwkToken(liveToken), { kwkId: 42 });
  assert.equal(verifyKwkDemoToken(liveToken), null);
});
