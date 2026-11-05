import assert from "node:assert/strict";
import test from "node:test";
import { serializeKwkFraudFlags } from "./kwkReferralPayload.js";

test("serializes referral fraud flags as stable text for the production TEXT column", () => {
  assert.equal(
    serializeKwkFraudFlags({ sameEmail: true, samePhone: false, sameAddress: false }),
    '{"sameEmail":true,"samePhone":false,"sameAddress":false}',
  );
});
