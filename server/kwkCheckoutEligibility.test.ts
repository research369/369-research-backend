import assert from "node:assert/strict";
import test from "node:test";
import { assertKwkNewCustomer } from "./kwkCheckoutEligibility.js";

test("KWK referral rejects absent or non-normalizable contact data before querying orders", async () => {
  let databaseWasUsed = false;
  const db = {
    select() {
      databaseWasUsed = true;
      throw new Error("Database must not be queried for an anonymous KWK referral");
    },
  };

  await assert.rejects(
    assertKwkNewCustomer(db, { email: "  ", phone: "keine nummer" }),
    /KWK_KONTAKT_ERFORDERLICH/,
  );
  assert.equal(databaseWasUsed, false);
});
