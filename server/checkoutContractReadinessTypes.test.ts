import assert from "node:assert/strict";
import test from "node:test";
import { TRPCError, type inferRouterInputs, type inferRouterOutputs, type TRPCDefaultErrorShape } from "@trpc/server";
import { z } from "zod";
import {
  adminProcedure,
  packingProcedure,
  productManagerProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  type Context,
} from "./trpc.js";

const inputSchema = z.object({ amount: z.number(), label: z.string() });
const regressionRouter = router({
  public: publicProcedure.input(inputSchema).query(({ ctx, input }) => ({
    amount: input.amount, label: input.label, userId: ctx.user?.id ?? null,
  })),
  protected: protectedProcedure.input(inputSchema).query(({ ctx, input }) => ({
    amount: input.amount, label: input.label, userId: ctx.user.id, role: ctx.user.role,
  })),
  admin: adminProcedure.input(inputSchema).query(({ ctx, input }) => ({
    amount: input.amount, label: input.label, userId: ctx.user.id, role: ctx.user.role,
  })),
  productManager: productManagerProcedure.input(inputSchema).query(({ ctx, input }) => ({
    amount: input.amount, label: input.label, userId: ctx.user.id, role: ctx.user.role,
  })),
  packing: packingProcedure.input(inputSchema).query(({ ctx, input }) => ({
    amount: input.amount, label: input.label, userId: ctx.user.id, role: ctx.user.role,
  })),
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Inputs = inferRouterInputs<typeof regressionRouter>;
type Outputs = inferRouterOutputs<typeof regressionRouter>;
type ExpectedInput = { amount: number; label: string };
type ExpectedAuthenticatedOutput = ExpectedInput & { userId: number; role: string };
type InferenceAssertions = [
  Assert<Equal<Inputs["public"], ExpectedInput>>,
  Assert<Equal<Inputs["protected"], ExpectedInput>>,
  Assert<Equal<Inputs["admin"], ExpectedInput>>,
  Assert<Equal<Inputs["productManager"], ExpectedInput>>,
  Assert<Equal<Inputs["packing"], ExpectedInput>>,
  Assert<Equal<Outputs["public"], { amount: number; label: string; userId: number | null }>>,
  Assert<Equal<Outputs["protected"], { amount: number; label: string; userId: number; role: string }>>,
  Assert<Equal<Outputs["admin"], Outputs["protected"]>>,
  Assert<Equal<Outputs["productManager"], Outputs["protected"]>>,
  Assert<Equal<Outputs["packing"], Outputs["protected"]>>,
  Assert<Outputs["protected"] extends ExpectedAuthenticatedOutput ? true : false>,
  Assert<Equal<typeof regressionRouter["_def"]["_config"]["$types"]["transformer"], true>>,
  Assert<Equal<typeof regressionRouter["_def"]["_config"]["$types"]["errorShape"], TRPCDefaultErrorShape>>,
];
// This value must typecheck; widening a builder to any or dropping the transformer fails the assertions.
const inferenceAssertions: InferenceAssertions = [true, true, true, true, true, true, true, true, true, true, true, true, true];

const input = { amount: 42, label: "offline" };
function context(role: string | null): Context {
  // No HTTP request/response is used by these local auth-only callers.
  return {
    req: {} as Context["req"],
    res: {} as Context["res"],
    user: role === null ? null : { id: 7, username: "local", name: null, email: null, role },
  };
}
const guardedRoutes = ["protected", "admin", "productManager", "packing"] as const;

test("public builder preserves typed input/output and accepts an unauthenticated local context", async () => {
  assert.ok(inferenceAssertions.every(Boolean));
  assert.deepEqual(await regressionRouter.createCaller(context(null)).public(input), { ...input, userId: null });
});

test("all authenticated builders still reject missing users", async () => {
  const caller = regressionRouter.createCaller(context(null));
  for (const route of guardedRoutes) {
    await assert.rejects(caller[route](input), (error: unknown) => error instanceof TRPCError && error.code === "UNAUTHORIZED");
  }
});

test("existing role matrix is unchanged and authenticated output retains non-null user", async () => {
  const acceptedRoles = {
    protected: ["admin", "product_manager", "packing", "customer"],
    admin: ["admin"],
    productManager: ["admin", "product_manager"],
    packing: ["admin", "packing"],
  };
  for (const role of ["admin", "product_manager", "packing", "customer"]) {
    const caller = regressionRouter.createCaller(context(role));
    for (const route of guardedRoutes) {
      if (acceptedRoles[route].includes(role)) {
        assert.deepEqual(await caller[route](input), { ...input, userId: 7, role });
      } else {
        await assert.rejects(caller[route](input), (error: unknown) => error instanceof TRPCError && error.code === "FORBIDDEN");
      }
    }
  }
});

test("typed procedures retain Zod input validation after annotation", async () => {
  const caller = regressionRouter.createCaller(context("admin"));
  for (const route of ["public", ...guardedRoutes] as const) {
    await assert.rejects(caller[route]({ amount: Number.NaN, label: "offline" }),
      (error: unknown) => error instanceof TRPCError && error.code === "BAD_REQUEST");
  }
});
