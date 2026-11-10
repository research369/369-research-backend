import assert from "node:assert/strict";
import test from "node:test";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { createOrderSchema, orderRouter } from "./orderRouter.js";
import { customerDataChangeRouter } from "./customerDataChangeRouter.js";

type Inputs = inferRouterInputs<typeof orderRouter>;
type Outputs = inferRouterOutputs<typeof orderRouter>;
type PreviewOutputs = inferRouterOutputs<typeof customerDataChangeRouter>;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const inferenceAssertions: [
  Assert<IsAny<Inputs["create"]> extends false ? true : false>,
  Assert<Inputs["create"]["customerDataChangeConfirmationToken"] extends string | undefined ? true : false>,
  Assert<"quantity_discount" extends NonNullable<Inputs["create"]["discountBreakdown"]>[number]["source"] ? true : false>,
  Assert<IsAny<Outputs["create"]> extends false ? true : false>,
  Assert<PreviewOutputs["previewCheckoutChange"]["requiresConfirmation"] extends boolean ? true : false>,
] = [true, true, true, true, true];

const basePayload = {
  items: [{ name: "Test", price: 1, quantity: 4, type: "peptide", shopProductId: "test" }],
  customer: { firstName: "Ada", lastName: "Test", phone: "000000", street: "Test", houseNumber: "1", zip: "10115", city: "Berlin", country: "DE" },
  subtotal: 4, discount: 0.4, discountCode: null, shipping: 8, shippingCountry: "de", total: 11.6, paymentMethod: "wise", date: "2026-11-05",
  discountBreakdown: [{ source: "quantity_discount", label: "Menge", amount: 0.4, percentage: 10 }],
};

test("actual Legacy schema accepts 369 quantity source; regular handler owns its amount", () => {
  assert.ok(inferenceAssertions.every(Boolean));
  const parsed = createOrderSchema.parse(basePayload);
  assert.equal(parsed.discountBreakdown?.[0]?.source, "quantity_discount");
  assert.equal(parsed.storeKey, "369research");
  assert.equal(parsed.discountBreakdown?.[0]?.amount, 0.4);
});

test("actual P4P schema retains rejection of new 369 quantity source", () => {
  assert.equal(createOrderSchema.safeParse({ ...basePayload, storeKey: "peps4pets" }).success, false);
  assert.equal(createOrderSchema.safeParse({ ...basePayload, storeKey: "peps4pets", discountBreakdown: [{ source: "promotion_code", label: "Promo", amount: 0.4 }] }).success, true);
});

test("actual token field is retained with main length constraints", () => {
  const payload = { ...basePayload, discountBreakdown: [] };
  assert.equal(createOrderSchema.safeParse({ ...payload, customerDataChangeConfirmationToken: "t".repeat(32) }).success, true);
  assert.equal(createOrderSchema.safeParse({ ...payload, customerDataChangeConfirmationToken: "t".repeat(31) }).success, false);
  assert.equal(createOrderSchema.safeParse({ ...payload, customerDataChangeConfirmationToken: "t".repeat(129) }).success, false);
});

test("broad existing admin/P4P payment enum is not narrowed by Wise-only 369 presentation", () => {
  for (const paymentMethod of ["bunq", "creditCard", "wise", "SEPA", "Bar", "Kreditkarte", "PayPal", "Crypto", "Guthaben", "Sonstige"]) {
    assert.equal(createOrderSchema.safeParse({ ...basePayload, storeKey: "peps4pets", discountBreakdown: [], paymentMethod }).success, true);
  }
});
