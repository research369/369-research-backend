import assert from "node:assert/strict";
import test from "node:test";
import { isBackupSchedulerDisabledForCommerceStaging } from "./backupService.js";

test("backup scheduler remains disabled only in explicit Commerce-Staging", () => {
  const previous = process.env.CHECKOUT_V2_COMMERCE_STAGING;

  try {
    delete process.env.CHECKOUT_V2_COMMERCE_STAGING;
    assert.equal(isBackupSchedulerDisabledForCommerceStaging(), false);

    process.env.CHECKOUT_V2_COMMERCE_STAGING = "false";
    assert.equal(isBackupSchedulerDisabledForCommerceStaging(), false);

    process.env.CHECKOUT_V2_COMMERCE_STAGING = "true";
    assert.equal(isBackupSchedulerDisabledForCommerceStaging(), true);
  } finally {
    if (previous === undefined) delete process.env.CHECKOUT_V2_COMMERCE_STAGING;
    else process.env.CHECKOUT_V2_COMMERCE_STAGING = previous;
  }
});
