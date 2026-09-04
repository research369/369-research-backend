import assert from "node:assert/strict";
import test from "node:test";
import { checkoutV2Router } from "./checkoutV2Router.js";

const minimalQuote = {
  selections: [{ shopProductId: "test-product", quantity: 1 }],
  delivery: { country: "Deutschland", deliveryType: "home" as const },
};

test("Checkout V2 quote is fail-closed outside explicit commerce staging", async () => {
  const previousStaging = process.env.CHECKOUT_V2_COMMERCE_STAGING;
  const previousFeature = process.env.FEATURE_CHECKOUT_V2_ENABLED;
  delete process.env.CHECKOUT_V2_COMMERCE_STAGING;
  delete process.env.FEATURE_CHECKOUT_V2_ENABLED;
  try {
    const caller = checkoutV2Router.createCaller({} as never);
    await assert.rejects(caller.quote(minimalQuote), (error: unknown) => {
      return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "FORBIDDEN");
    });
  } finally {
    if (previousStaging === undefined) delete process.env.CHECKOUT_V2_COMMERCE_STAGING;
    else process.env.CHECKOUT_V2_COMMERCE_STAGING = previousStaging;
    if (previousFeature === undefined) delete process.env.FEATURE_CHECKOUT_V2_ENABLED;
    else process.env.FEATURE_CHECKOUT_V2_ENABLED = previousFeature;
  }
});

const minimalCompletion = {
  ...minimalQuote,
  customer: {
    firstName: "Test",
    lastName: "Kunde",
    email: "test@example.com",
    phone: "491234567890",
    street: "Teststraße",
    houseNumber: "1",
    zip: "12345",
    city: "Berlin",
    country: "Deutschland",
  },
  paymentMethod: "SEPA" as const,
  idempotencyKey: "checkout-v2-test-idempotency-key-001",
  acknowledgements: {
    researchOnly: true as const,
    ageConfirmed: true as const,
    noReturnConfirmed: true as const,
    addressConfirmed: true as const,
  },
};

test("Checkout V2 completion is fail-closed outside explicit commerce staging", async () => {
  const previousStaging = process.env.CHECKOUT_V2_COMMERCE_STAGING;
  const previousFeature = process.env.FEATURE_CHECKOUT_V2_ENABLED;
  delete process.env.CHECKOUT_V2_COMMERCE_STAGING;
  delete process.env.FEATURE_CHECKOUT_V2_ENABLED;
  try {
    const caller = checkoutV2Router.createCaller({} as never);
    await assert.rejects(caller.complete(minimalCompletion), (error: unknown) => {
      return Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "FORBIDDEN");
    });
  } finally {
    if (previousStaging === undefined) delete process.env.CHECKOUT_V2_COMMERCE_STAGING;
    else process.env.CHECKOUT_V2_COMMERCE_STAGING = previousStaging;
    if (previousFeature === undefined) delete process.env.FEATURE_CHECKOUT_V2_ENABLED;
    else process.env.FEATURE_CHECKOUT_V2_ENABLED = previousFeature;
  }
});
