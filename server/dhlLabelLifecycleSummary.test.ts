import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { closeDb } from "./db.js";
import { ENV } from "./env.js";
import {
  getDhlLabelLifecycleForOrders,
  isDhlLabelLifecycleUsable,
  type DhlLabelLifecycleSummary,
} from "./dhlLabelLifecycleSummary.js";
import {
  ensureDhlRelabelSchema,
  isDhlRelabelSchemaReady,
  markDhlRelabelSchemaUnavailable,
} from "./dhlRelabelSchema.js";

type Generation = { orderId: string; id: string; generation: number; state: string };
type Operation = { orderId: string; state: string };
const calls: { sql: string; params: unknown[] }[] = [];
let generations: Generation[] = [];
let operations: Operation[] = [];
let queryFailure: unknown;
let queryHook: (() => Promise<void>) | undefined;
const originalDatabaseUrl = ENV.databaseUrl;

before(async () => {
  // Stub every possible PG query/end before initializing the actual getPool.
  // Pool construction is local only; no socket, live DB, DHL or HTTP calls.
  mock.method(pg.Pool.prototype as any, "query", async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (queryHook) await queryHook();
    if (queryFailure) throw queryFailure;
    if (!sql.trimStart().startsWith("SELECT")) return { rows: [], rowCount: 0 };
    const rows = (params[0] as string[]).map(orderId => {
      const g = generations.filter(g => g.orderId === orderId && g.state !== "create_rejected")
        .sort((a, b) => b.generation - a.generation)[0];
      return {
        order_id: orderId,
        generation_id: g?.id ?? null,
        state: g?.state ?? null,
        blocked: operations.some(o => o.orderId === orderId && ["pending", "unknown"].includes(o.state)),
        // Even unexpected extra driver fields must never escape the projection.
        actor: "private-test-actor",
        label_content: "PRIVATE-TEST-PDF",
        recipient_snapshot: { street: "private-test-address" },
      };
    });
    return { rows, rowCount: rows.length };
  });
  mock.method(pg.Pool.prototype as any, "end", async () => {});
  await closeDb();
  ENV.databaseUrl = "postgresql://mock:mock@127.0.0.1:1/mock_no_network";
});

beforeEach(() => {
  calls.length = 0;
  generations = [];
  operations = [];
  queryFailure = undefined;
  queryHook = undefined;
  markDhlRelabelSchemaUnavailable();
});

after(async () => {
  await closeDb();
  ENV.databaseUrl = originalDatabaseUrl;
  mock.restoreAll();
});

test("empty batch has no DB query and returns an empty Map", async () => {
  const result = await getDhlLabelLifecycleForOrders([]);
  assert.ok(result instanceof Map);
  assert.equal(result.size, 0);
  assert.equal(calls.length, 0);
  assert.equal(isDhlRelabelSchemaReady(), false);
});

test("batch selects latest generation excluding create_rejected, parameterizes and deduplicates IDs", async () => {
  generations = [
    { orderId: "a", id: "a1", generation: 1, state: "active" },
    { orderId: "a", id: "a3", generation: 3, state: "create_rejected" },
    { orderId: "a", id: "a2", generation: 2, state: "cancelled" },
    { orderId: "b", id: "b1", generation: 1, state: "active" },
  ];
  const injectedId = "x'); DELETE FROM orders;--";
  const result = await getDhlLabelLifecycleForOrders(["a", "b", "a", injectedId]);
  assert.deepEqual(result.get("a"), { generationId: "a2", state: "cancelled", blocked: false });
  assert.deepEqual(result.get("b"), { generationId: "b1", state: "active", blocked: false });
  assert.equal(result.has(injectedId), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [["a", "b", injectedId]]);
  const sql = calls[0].sql;
  assert.match(sql, /^\s*SELECT\b/);
  assert.match(sql, /unnest\(\$1::varchar\[\]\)/);
  assert.match(sql, /generation\.state <> 'create_rejected'/);
  assert.match(sql, /ORDER BY generation\.generation DESC\s+LIMIT 1/);
  assert.match(sql, /operation\.order_id = requested\.order_id/);
  assert.match(sql, /operation\.state IN \('pending', 'unknown'\)/);
  assert.doesNotMatch(sql, /SELECT\s+\*|FOR UPDATE|\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|ALTER|CREATE)\b|recipient|snapshot|label_content|actor|tracking_number/i);
  assert.ok(!sql.includes(injectedId));
  assert.equal(isDhlRelabelSchemaReady(), false, "successful SELECT alone cannot certify full migration");
});

test("legacy IDs with no generation or only rejected attempts remain absent/null", async () => {
  generations = [{ orderId: "rejected", id: "r1", generation: 1, state: "create_rejected" }];
  operations = [{ orderId: "rejected", state: "rejected" }];
  const result = await getDhlLabelLifecycleForOrders(["legacy", "rejected"]);
  assert.equal(result.size, 0);
  assert.equal(result.get("legacy") ?? null, null);
  assert.equal(isDhlLabelLifecycleUsable(result.get("rejected") ?? null), true);
});

test("pending and unknown operations block order-wide regardless of current generation", async () => {
  generations = [
    { orderId: "pending", id: "p2", generation: 2, state: "active" },
    { orderId: "unknown", id: "u2", generation: 2, state: "manifested" },
    { orderId: "resolved", id: "r1", generation: 1, state: "cancel_rejected" },
  ];
  operations = [
    { orderId: "pending", state: "pending" },
    { orderId: "unknown", state: "unknown" },
    { orderId: "resolved", state: "succeeded" },
    { orderId: "resolved", state: "rejected" },
  ];
  const result = await getDhlLabelLifecycleForOrders(["pending", "unknown", "resolved"]);
  assert.deepEqual(result.get("pending"), { generationId: "p2", state: "active", blocked: true });
  assert.deepEqual(result.get("unknown"), { generationId: "u2", state: "manifested", blocked: true });
  assert.deepEqual(result.get("resolved"), { generationId: "r1", state: "cancel_rejected", blocked: false });
  assert.doesNotMatch(calls[0].sql, /operation\.generation_id/);
});

test("unresolved operation without a current generation returns unknown+blocked instead of legacy null", async () => {
  generations = [{ orderId: "rejected", id: "r1", generation: 1, state: "create_rejected" }];
  operations = [{ orderId: "orphan", state: "pending" }, { orderId: "rejected", state: "unknown" }];
  const result = await getDhlLabelLifecycleForOrders(["orphan", "rejected"]);
  for (const id of ["orphan", "rejected"]) {
    assert.deepEqual(result.get(id), { generationId: null, state: "unknown", blocked: true });
  }
});

test("summary retains document failure state and projects only its three safe fields", async () => {
  generations = [{ orderId: "docs", id: "d1", generation: 1, state: "documents_failed" }];
  const result = await getDhlLabelLifecycleForOrders(["docs"]);
  assert.deepEqual(result.get("docs"), { generationId: "d1", state: "documents_failed", blocked: false });
  assert.deepEqual(Object.keys(result.get("docs")!).sort(), ["blocked", "generationId", "state"]);
  assert.doesNotMatch(JSON.stringify([...result]), /private-test|PRIVATE-TEST|snapshot|actor|label_content/);
});

test("schema not initialized is false; exact successful ensure is true", async () => {
  assert.equal(isDhlRelabelSchemaReady(), false);
  await ensureDhlRelabelSchema();
  assert.equal(isDhlRelabelSchemaReady(), true);
  const sql = await readFile(new URL("../drizzle/migrations/0031_dhl_label_generations.sql", import.meta.url), "utf8");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, sql);
});

test("readiness remains false while ensure is still running", async () => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  queryHook = () => new Promise<void>(resolve => { release = resolve; started(); });
  const ensuring = ensureDhlRelabelSchema();
  await startedPromise;
  assert.equal(isDhlRelabelSchemaReady(), false);
  release();
  await ensuring;
  assert.equal(isDhlRelabelSchemaReady(), true);
});

test("failed ensure clears a previously ready marker and still rejects", async () => {
  await ensureDhlRelabelSchema();
  assert.equal(isDhlRelabelSchemaReady(), true);
  queryFailure = new Error("mock migration failure");
  await assert.rejects(ensureDhlRelabelSchema(), /mock migration failure/);
  assert.equal(isDhlRelabelSchemaReady(), false);
});

test("missing tables fail closed for every requested DHL ID without rejecting order list", async () => {
  await ensureDhlRelabelSchema();
  queryFailure = Object.assign(new Error("mock sensitive missing table detail"), { code: "42P01" });
  const result = await getDhlLabelLifecycleForOrders(["a", "b", "a"]);
  assert.equal(result.size, 2);
  for (const id of ["a", "b"]) {
    assert.deepEqual(result.get(id), { generationId: null, state: "unknown", blocked: true });
  }
  assert.equal(isDhlRelabelSchemaReady(), false);
  assert.doesNotMatch(JSON.stringify([...result]), /sensitive|42P01/);
});

test("missing schema and permission errors also clear readiness without throwing", async () => {
  for (const code of ["3F000", "42501"]) {
    queryFailure = undefined;
    await ensureDhlRelabelSchema();
    queryFailure = Object.assign(new Error("mock unavailable ledger schema"), { code });
    const result = await getDhlLabelLifecycleForOrders(["dhl"]);
    assert.deepEqual(result.get("dhl"), { generationId: null, state: "unknown", blocked: true });
    assert.equal(isDhlRelabelSchemaReady(), false);
  }
});

test("transient ledger errors fail closed for the read without poisoning initialized readiness", async () => {
  await ensureDhlRelabelSchema();
  queryFailure = Object.assign(new Error("mock timeout (no actual network)"), { code: "57014" });
  const result = await getDhlLabelLifecycleForOrders(["dhl"]);
  assert.deepEqual(result.get("dhl"), { generationId: null, state: "unknown", blocked: true });
  assert.equal(isDhlRelabelSchemaReady(), true);
  queryFailure = undefined;
  await getDhlLabelLifecycleForOrders(["dhl"]);
  assert.equal(isDhlRelabelSchemaReady(), true);
});

test("successful summary after a confirmed schema failure cannot restore readiness", async () => {
  await ensureDhlRelabelSchema();
  queryFailure = Object.assign(new Error("mock missing table"), { code: "42P01" });
  await getDhlLabelLifecycleForOrders(["dhl"]);
  assert.equal(isDhlRelabelSchemaReady(), false);
  queryFailure = undefined;
  await getDhlLabelLifecycleForOrders(["dhl"]);
  assert.equal(isDhlRelabelSchemaReady(), false);
});

test("missing pool fails closed in summary and rejects ensure without any SQL or external call", async () => {
  await closeDb();
  ENV.databaseUrl = "";
  try {
    const result = await getDhlLabelLifecycleForOrders(["dhl"]);
    assert.deepEqual(result.get("dhl"), { generationId: null, state: "unknown", blocked: true });
    await assert.rejects(ensureDhlRelabelSchema(), /Datenbank/);
    assert.equal(isDhlRelabelSchemaReady(), false);
    assert.equal(calls.length, 0);
  } finally {
    ENV.databaseUrl = "postgresql://mock:mock@127.0.0.1:1/mock_no_network";
  }
});

test("migration preserves both plain order IDs but retains the operation-generation restrictive FK", async () => {
  const sql = await readFile(new URL("../drizzle/migrations/0031_dhl_label_generations.sql", import.meta.url), "utf8");
  assert.equal([...sql.matchAll(/order_id VARCHAR\(32\) NOT NULL,/g)].length, 2);
  assert.doesNotMatch(sql, /REFERENCES\s+orders\b|FOREIGN KEY\s*\(order_id\)/i);
  assert.match(sql, /generation_id UUID NOT NULL REFERENCES dhl_label_generations\(id\) ON DELETE RESTRICT/);
  assert.equal([...sql.matchAll(/REFERENCES/g)].length, 1);
  assert.doesNotMatch(sql, /ON DELETE CASCADE|DROP|DELETE FROM|UPDATE orders/i);
});

test("usable predicate preserves null legacy and allows only unblocked active/cancel_rejected/manifested", () => {
  assert.equal(isDhlLabelLifecycleUsable(null), true);
  for (const state of ["active", "cancel_rejected", "manifested"]) {
    assert.equal(isDhlLabelLifecycleUsable({ generationId: "test-id", state, blocked: false }), true, state);
    assert.equal(isDhlLabelLifecycleUsable({ generationId: "test-id", state, blocked: true }), false, state);
  }
  for (const state of ["unknown", "cancelled", "documents_failed", "create_pending", "create_unknown", "cancel_pending", "cancel_unknown", "create_rejected", "delivered", "future_state", ""]) {
    for (const blocked of [false, true]) {
      const summary: DhlLabelLifecycleSummary = { generationId: null, state, blocked };
      assert.equal(isDhlLabelLifecycleUsable(summary), false, `${state} blocked=${blocked}`);
    }
  }
});
