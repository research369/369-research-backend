import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

describe("WaWi dashboard read model", () => {
  it("uses SQL aggregation and explicit limits instead of dashboard full-table routes", async () => {
    const source = await readFile(path.join(root, "server/dashboardRouter.ts"), "utf8");
    assert.match(source, /COUNT\(\*\)/);
    assert.match(source, /SUM\(o\.total::numeric\)/);
    assert.match(source, /LIMIT \$3/);
    assert.match(source, /JOIN order_items i ON i\.order_id = o\.order_id/);
    assert.match(source, /FROM shop_settings/);
    assert.match(source, /shopStatus:/);
  });

  it("declares additive performance indexes for order items and stock movement timelines", async () => {
    const schema = await readFile(path.join(root, "drizzle/schema.ts"), "utf8");
    assert.match(schema, /order_items_order_id_idx/);
    assert.match(schema, /stock_history_created_at_idx/);
    assert.match(schema, /stock_history_article_created_at_idx/);
  });
});
