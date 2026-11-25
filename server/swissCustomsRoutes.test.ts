import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { orders, orderItems, users } from "../drizzle/schema.js";
import { createToken } from "./auth.js";
import { closeDb, getDb } from "./db.js";
import { ENV } from "./env.js";
import { dhlExpressRouter } from "./dhlExpressRouter.js";

const routePath = "/api/shipping/dhl/swiss-customs/:orderId";
const originalDatabaseUrl = ENV.databaseUrl;
const originalRows = [
  { id: 11, name: "Original first", dosage: "10 mg", variant: "single", quantity: 3 },
  { id: 12, name: "Original second", dosage: "20 mg", variant: null, quantity: 2 },
];
let order: any;
let role: string;
let savedRows: any[];
let writes: { sql: string; params: any[] }[];
let pendingRows: any[];
let externalCalls = 0;
let releaseCalls = 0;
let failInsert = false;

function item(orderItemId: number, overrides: Record<string, unknown> = {}) {
  return { orderItemId, description: "Actual shipment material", hsCode: "", countryOfOrigin: "", unitWeightGrams: 20, unitCustomsValueEur: 10, ...overrides };
}
function body(items: unknown = [item(11)], excludedOrderItemIds: unknown = [12]) {
  return { packageWeightGrams: 500, complianceConfirmed: true, items, excludedOrderItemIds };
}

// Exercise the actual registered Express middleware and handlers without opening
// sockets. Auth resolves a local signed JWT through the same mocked DB as the route.
async function invoke(method: "get" | "put", input?: unknown, authenticated = true) {
  const layer = (dhlExpressRouter as any).stack.find((entry: any) => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `registered ${method.toUpperCase()} route`);
  const req: any = { params: { orderId: "ISOLATED-CH-SELECTION" }, headers: authenticated ? { authorization: `Bearer ${createToken(1, role)}` } : {}, body: input };
  const response = { status: 200, body: undefined as any };
  const res: any = {
    status(code: number) { response.status = code; return this; },
    json(payload: unknown) { response.body = payload; return this; },
  };
  for (const middleware of layer.route.stack) {
    let proceed = false;
    await middleware.handle(req, res, () => { proceed = true; });
    if (!proceed) break;
  }
  assert.notEqual(response.body, undefined);
  return response;
}

before(async () => {
  // Stub all PG entrypoints and HTTP before constructing a local Pool; no socket,
  // production DB, DHL, email, stock or payment code can run in these tests.
  mock.method(globalThis, "fetch", async () => { externalCalls++; throw Error("HTTP_FORBIDDEN"); });
  mock.method(pg.Pool.prototype as any, "query", async (sql: string, params: any[]) => {
    assert.match(sql, /^\s*SELECT declaration\.package_weight_grams/);
    assert.deepEqual(params, ["ISOLATED-CH-SELECTION"]);
    return { rows: savedRows, rowCount: savedRows.length };
  });
  mock.method(pg.Pool.prototype as any, "connect", async () => ({
    query: async (sql: string, params: any[] = []) => {
      writes.push({ sql, params });
      const normalized = sql.trim();
      if (normalized === "BEGIN") { pendingRows = []; return { rows: [] }; }
      if (normalized.startsWith("INSERT INTO order_swiss_customs_declarations")) {
        assert.equal(params[0], "ISOLATED-CH-SELECTION");
        assert.equal(params[1], 500);
        assert.match(sql, /'DAP'/);
        return { rows: [{ id: 41 }] };
      }
      if (normalized === "DELETE FROM order_swiss_customs_items WHERE declaration_id = $1") {
        assert.deepEqual(params, [41]);
        return { rows: [] };
      }
      if (normalized.startsWith("INSERT INTO order_swiss_customs_items")) {
        if (failInsert) throw Error("ISOLATED_INSERT_FAILURE");
        pendingRows.push({ package_weight_grams: 500, compliance_confirmed_at: new Date(), order_item_id: params[1], item_description: params[2], hs_code: params[3], country_of_origin: params[4], unit_weight_grams: params[5], unit_customs_value_eur: params[6] });
        return { rows: [] };
      }
      if (normalized === "COMMIT") { savedRows = pendingRows; return { rows: [] }; }
      if (normalized === "ROLLBACK") return { rows: [] };
      throw Error(`UNEXPECTED_WRITE: ${normalized}`);
    },
    release() { releaseCalls++; },
  }));
  mock.method(pg.Pool.prototype as any, "end", async () => {});
  await closeDb();
  ENV.databaseUrl = "postgresql://mock:mock@127.0.0.1:1/mock_no_network";
  const db = await getDb();
  assert.ok(db);
  mock.method(db, "select", () => {
    let table: unknown;
    const rows = () => table === users ? [{ id: 1, username: "isolated-admin", name: "Isolated admin", role }]
      : table === orders ? (order ? [order] : []) : table === orderItems ? originalRows.map((row) => ({ ...row })) : (() => { throw Error("UNEXPECTED_TABLE"); })();
    const query: any = {
      from(value: unknown) { table = value; return query; },
      where() { return query; },
      limit() { return Promise.resolve(rows()); },
      then(resolve: any, reject: any) { return Promise.resolve(rows()).then(resolve, reject); },
    };
    return query;
  });
});

beforeEach(() => {
  order = { orderId: "ISOLATED-CH-SELECTION", country: "CH", trackingNumber: null, shippingLabelUrl: null, shipping: "5", subtotal: "50", discount: "0" };
  role = "admin";
  savedRows = [];
  pendingRows = [];
  writes = [];
  externalCalls = 0;
  releaseCalls = 0;
  failInsert = false;
});

after(async () => {
  await closeDb();
  ENV.databaseUrl = originalDatabaseUrl;
  mock.restoreAll();
});

test("new GET draft has all original positions, blank customs fields and no exclusions", async () => {
  const result = await invoke("get");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items.map((row: any) => row.orderItemId), [11, 12]);
  assert.deepEqual(result.body.excludedItems, []);
  assert.equal(result.body.packageWeightGrams, null);
  assert.equal(result.body.complianceConfirmed, false);
  for (const line of result.body.items) {
    assert.equal(line.description, "");
    assert.equal(line.unitCustomsValueEur, null);
  }
  assert.deepEqual(writes, []);
});

test("PUT persists only selected lines; GET reload returns selected and metadata-only excluded complement", async () => {
  const snapshot = structuredClone(originalRows);
  const saved = await invoke("put", body([item(11, { quantity: 999 })]));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.goodsValueEur, 30, "quantity is original 3, not submitted 999");
  const inserted = writes.filter((call) => call.sql.trim().startsWith("INSERT INTO order_swiss_customs_items"));
  assert.equal(inserted.length, 1);
  assert.deepEqual(inserted[0].params, [41, 11, "Actual shipment material", null, null, 20, 10]);
  assert.equal(writes.at(-1)?.sql, "COMMIT");
  assert.equal(releaseCalls, 1);
  const loaded = await invoke("get");
  assert.deepEqual(loaded.body.items.map((row: any) => row.orderItemId), [11]);
  assert.equal(loaded.body.items[0].quantity, 3);
  assert.equal(loaded.body.items[0].description, "Actual shipment material");
  const { id, ...metadata } = originalRows[1];
  assert.deepEqual(loaded.body.excludedItems, [{ orderItemId: id, ...metadata }]);
  assert.deepEqual(Object.keys(loaded.body.excludedItems[0]).sort(), ["dosage", "name", "orderItemId", "quantity", "variant"]);
  assert.deepEqual(originalRows, snapshot);
  assert.equal(externalCalls, 0);
});

test("legacy all-items PUT without excludedOrderItemIds remains valid", async () => {
  const input = body([item(11), item(12)]);
  delete (input as any).excludedOrderItemIds;
  const result = await invoke("put", input);
  assert.equal(result.status, 200);
  assert.equal(result.body.goodsValueEur, 50);
  assert.deepEqual(savedRows.map((row) => row.order_item_id), [11, 12]);
  assert.deepEqual((await invoke("get")).body.excludedItems, []);
});

test("an excluded original row can be restored and resaved with real customs data", async () => {
  await invoke("put", body());
  const loaded = await invoke("get");
  const result = await invoke("put", body([item(11), item(loaded.body.excludedItems[0].orderItemId)], []));
  assert.equal(result.status, 200);
  assert.deepEqual(savedRows.map((row) => row.order_item_id), [11, 12]);
  assert.deepEqual((await invoke("get")).body.excludedItems, []);
});

test("a declaration LEFT JOIN row with null item ID does not resurrect all originals", async () => {
  savedRows = [{ package_weight_grams: 500, compliance_confirmed_at: new Date(), order_item_id: null }];
  const result = await invoke("get");
  assert.deepEqual(result.body.items, []);
  assert.deepEqual(result.body.excludedItems, originalRows.map(({ id, ...metadata }) => ({ orderItemId: id, ...metadata })));
});

for (const [name, input] of [
  ["implicit missing position", body([item(11)], [])],
  ["all removed", body([], [11, 12])],
  ["selected duplicates", body([item(11), item(11)], [12])],
  ["excluded duplicates", body([item(11)], [12, 12])],
  ["overlap", body([item(11)], [11, 12])],
  ["foreign selected", body([item(99)], [11, 12])],
  ["foreign excluded", body([item(11)], [12, 99])],
  ["null selected", body([null], [12])],
  ["invalid selected ID", body([item(11.5)], [12])],
  ["invalid excluded ID", body([item(11)], ["12"])],
  ["invalid exclusion list", body([item(11), item(12)], null)],
  ["no compliance", { ...body(), complianceConfirmed: false }],
  ["missing actual values", body([item(11, { description: "", unitCustomsValueEur: 0 })])],
  ["missing package weight", { ...body(), packageWeightGrams: null }],
  ["package too light", { ...body(), packageWeightGrams: 10 }],
  ["ABD threshold", body([item(11, { unitCustomsValueEur: 400 })])],
] as const) {
  test(`PUT rejects ${name} before any write`, async () => {
    const result = await invoke("put", input);
    assert.equal(result.status, 422);
    assert.equal(result.body.success, false);
    assert.deepEqual(writes, []);
    assert.equal(externalCalls, 0);
  });
}

for (const field of ["trackingNumber", "shippingLabelUrl"]) {
  test(`existing ${field} label-created protection stays 409`, async () => {
    order[field] = "MOCK-EXISTING-LABEL";
    assert.equal((await invoke("put", body())).status, 409);
    assert.deepEqual(writes, []);
  });
}

for (const method of ["get", "put"] as const) {
  test(`${method.toUpperCase()} remains admin-only`, async () => {
    assert.equal((await invoke(method, body(), false)).status, 401);
    role = "packing";
    assert.equal((await invoke(method, body())).status, 403);
    assert.deepEqual(writes, []);
  });
  test(`${method.toUpperCase()} rejects non-Swiss orders and missing orders`, async () => {
    order.country = "DE";
    assert.equal((await invoke(method, body())).status, 422);
    order = null;
    assert.equal((await invoke(method, body())).status, 404);
    assert.deepEqual(writes, []);
  });
}

test("failed selected-line persistence rolls back and releases without replacing the prior draft", async () => {
  await invoke("put", body());
  const priorRows = structuredClone(savedRows);
  writes = [];
  failInsert = true;
  const logged = mock.method(console, "error", () => {});
  try {
    const result = await invoke("put", body([item(12)], [11]));
    assert.equal(result.status, 500);
    assert.equal(writes.at(-1)?.sql, "ROLLBACK");
    assert.deepEqual(savedRows, priorRows);
    assert.equal(releaseCalls, 2);
    assert.equal(externalCalls, 0);
  } finally { logged.mock.restore(); }
});

test("selection removal adds no HTTP DELETE route and mutates only customs draft tables", async () => {
  assert.equal((dhlExpressRouter as any).stack.some((entry: any) => entry.route?.path === routePath && entry.route.methods.delete), false);
  await invoke("put", body());
  const mutationTables = writes.flatMap(({ sql }) => [...sql.matchAll(/(?:INSERT INTO|DELETE FROM|UPDATE)\s+([a-z_]+)/gi)]
    .map((match) => match[1].toLowerCase()).filter((table) => table !== "set"));
  assert.deepEqual([...new Set(mutationTables)].sort(), ["order_swiss_customs_declarations", "order_swiss_customs_items"]);
  const source = await readFile(new URL("./dhlExpressRouter.ts", import.meta.url), "utf8");
  const putStart = source.indexOf(`dhlExpressRouter.put(\n  "${routePath}"`);
  assert.ok(putStart >= 0);
  const putSource = source.slice(putStart, source.indexOf("dhlExpressRouter.get(", putStart));
  assert.doesNotMatch(putSource, /(?:DELETE FROM|UPDATE|INSERT INTO)\s+(?:orders|order_items)\b/i);
  assert.doesNotMatch(putSource, /db\.(?:update|delete|insert)\(|stock|payment|sendEmail|sendWhatsApp|requestDhlLabel\(|dhlOperations\.execute/);
  assert.equal(externalCalls, 0);
});
