import test from "node:test";
import assert from "node:assert/strict";
import { getColdShippingAvailability } from "./coldShippingAvailability.js";

test("partial island territory rule denies exact ISO and multilingual island names", async () => {
  for (const country of ["GB", "UK", "Großbritannien", "Ireland", "IE", "Malta", "MT", "CY", "Zypern", "IS", "Japan"]) {
    const result = await getColdShippingAvailability({ country, zip: "TEST", city: "TEST" });
    assert.equal(result.eligible, false); assert.equal(result.status, "island");
    assert.equal(result.policyMode, "reviewed-island-postcodes");
  }
});

test("known mainland postcode false negatives do not enter the productively enforced policy", async () => {
  for (const [country, zip, city] of [["CH", "8880", "Walenstadt"], ["CH", "8400", "Winterthur"], ["CH", "8001", "Zürich"], ["DE", "20354", "Hamburg"], ["DE", "70173", "Stuttgart"], ["FR", "06000", "Nice"], ["AT", "1010", "Wien"]]) {
    const result = await getColdShippingAvailability({ country, zip, city });
    assert.equal(result.eligible, true); assert.equal(result.status, "unknown");
    assert.equal(result.policyMode, "reviewed-island-postcodes");
  }
});
