import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TRPCError } from "@trpc/server";
import { router, stockProcedure, packingProcedure, adminProcedure, type Context } from "./trpc.js";
import { articleRouter } from "./articleRouter.js";
import { applyStockMovement } from "./stockMovementService.js";

const context = (role: string | null): Context => ({
  req: {} as Context["req"],
  res: {} as Context["res"],
  user: role === null ? null : { id: 1, username: "test-operator", name: null, email: null, role },
});
const permissionRouter = router({
  stock: stockProcedure.query(() => "stock-ok"),
  packing: packingProcedure.query(() => "packing-ok"),
  admin: adminProcedure.query(() => "admin-ok"),
});
const denied = (code: string) => (error: unknown) => error instanceof TRPCError && error.code === code;

for (const role of ["admin", "packing", "product_manager"]) {
  test(`inventory-only permission allows ${role}`, async () => {
    assert.equal(await permissionRouter.createCaller(context(role)).stock(), "stock-ok");
  });
}
for (const role of [null, "customer", "partner", "creator", "user", "product_manager_extra"]) {
  test(`inventory-only permission denies ${role ?? "anonymous"}`, async () => {
    await assert.rejects(permissionRouter.createCaller(context(role)).stock(), denied(role === null ? "UNAUTHORIZED" : "FORBIDDEN"));
    await assert.rejects(articleRouter.createCaller(context(role)).adjustStock({ id: 42, change: 20, type: "korrektur" }), denied(role === null ? "UNAUTHORIZED" : "FORBIDDEN"));
  });
}
test("product manager is not upgraded to packing or admin", async () => {
  const caller = permissionRouter.createCaller(context("product_manager"));
  await assert.rejects(caller.packing(), denied("FORBIDDEN"));
  await assert.rejects(caller.admin(), denied("FORBIDDEN"));
});
test("existing admin and packing permissions remain unchanged", async () => {
  assert.equal(await permissionRouter.createCaller(context("admin")).admin(), "admin-ok");
  assert.equal(await permissionRouter.createCaller(context("admin")).packing(), "packing-ok");
  assert.equal(await permissionRouter.createCaller(context("packing")).packing(), "packing-ok");
  await assert.rejects(permissionRouter.createCaller(context("packing")).admin(), denied("FORBIDDEN"));
});
test("real stock route validates integer changes and expected stock before accessing the database", async () => {
  const caller = articleRouter.createCaller(context("product_manager"));
  for (const input of [
    { id: 42, change: 1.5, type: "korrektur" as const },
    { id: 42, change: 20, type: "korrektur" as const, expectedStock: -1 },
    { id: 42, change: 20, type: "korrektur" as const, expectedStock: 1.5 },
    { id: 42, change: 20, type: "korrektur" as const, expectedStock: 2147483648 },
  ]) {
    await assert.rejects(caller.adjustStock(input), denied("BAD_REQUEST"));
  }
});
test("stockProcedure is wired exclusively to adjustStock and keeps conflict checking and history", () => {
  const source = readFileSync(new URL("./articleRouter.ts", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/(\w+):\s*stockProcedure/g)].map(match => match[1]), ["adjustStock"]);
  assert.match(source, /input\.expectedStock !== undefined && article\.stock !== input\.expectedStock/);
  assert.match(source, /db\.transaction\(async tx=>\{await applyStockMovement/);
  assert.match(source, /ctx\.user\?\.name\|\|ctx\.user\?\.username\|\|"Admin"/);
});

function fakeTransaction(stock: number) {
  const writes: unknown[] = [];
  const row = { id: 42, sku: "CAGRILINITIDE-10MG", stock, sellingPrice: "90", salePrice: "0" };
  const db = {
    select: () => ({ from: () => ({ where: () => ({ for: async () => [row] }) }) }),
    update: () => ({ set: (value: unknown) => ({ where: async () => { writes.push({ update: value }); } }) }),
    insert: () => ({ values: (value: unknown) => ({ returning: async () => { writes.push({ history: value }); return [{ id: 77 }]; } }) }),
  };
  return { db, writes };
}
const movement = { articleId: 42, sku: "CAGRILINITIDE-10MG", expectedStock: 0, change: 20, type: "korrektur" as const, reason: "Pakko: Bestand 20 Stück", actor: "product_manager" };
test("canonical stock movement writes target count and attributed history together", async () => {
  const { db, writes } = fakeTransaction(0);
  assert.deepEqual(await applyStockMovement(db, movement), { before: 0, after: 20, movementId: 77 });
  assert.equal(writes.length, 2);
  assert.deepEqual((writes[1] as { history: unknown }).history, {
    articleId: 42, quantityBefore: 0, quantityChange: 20, quantityAfter: 20,
    changeType: "korrektur", reason: movement.reason, orderId: null, userName: "product_manager",
  });
});
test("changed stock or SKU cannot be overwritten or audited as a successful movement", async () => {
  for (const input of [{ ...movement, expectedStock: 1 }, { ...movement, sku: "WRONG-SKU" }]) {
    const { db, writes } = fakeTransaction(0);
    await assert.rejects(applyStockMovement(db, input), /stock_conflict/);
    assert.equal(writes.length, 0);
  }
});
test("negative and overflowing inventory remain forbidden", async () => {
  for (const change of [-1, 2147483648]) {
    const { db, writes } = fakeTransaction(0);
    await assert.rejects(applyStockMovement(db, { ...movement, change }), /invalid_stock/);
    assert.equal(writes.length, 0);
  }
});
