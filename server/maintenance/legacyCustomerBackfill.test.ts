import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");

describe("legacy customer backfill isolation", () => {
  it("keeps the full historical scan out of every normal server startup", async () => {
    const startup = await readFile(path.join(root, "server/index.ts"), "utf8");
    const maintenance = await readFile(path.join(root, "server/maintenance/legacyCustomerBackfill.ts"), "utf8");

    assert.doesNotMatch(startup, /SELECT \* FROM orders WHERE customer_id IS NULL/);
    assert.match(maintenance, /SELECT \* FROM orders WHERE customer_id IS NULL/);
    assert.match(maintenance, /explicit, monitored maintenance task/);
  });
});
