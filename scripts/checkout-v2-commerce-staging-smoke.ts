import "dotenv/config";
import assert from "node:assert/strict";
import pg from "pg";
import { checkoutV2Router } from "../server/checkoutV2Router.js";

const { Client } = pg;

function fail(message: string): never {
  console.error(`[Checkout V2 Commerce Staging Smoke] ${message}`);
  process.exit(1);
}

function requireIsolatedMode(): string {
  if (process.env.CHECKOUT_V2_COMMERCE_STAGING !== "true") fail("CHECKOUT_V2_COMMERCE_STAGING must be true.");
  if (process.env.CHECKOUT_V2_TEST_MODE !== "true") fail("CHECKOUT_V2_TEST_MODE must be true.");
  if (process.env.FEATURE_CHECKOUT_V2_ENABLED !== "true") fail("FEATURE_CHECKOUT_V2_ENABLED must be true.");
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) fail("DATABASE_URL is required.");
  return databaseUrl;
}

async function resetSyntheticData(client: pg.Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM order_items WHERE order_id IN (SELECT order_id FROM orders WHERE store_key = 'checkout-v2')");
    await client.query("DELETE FROM orders WHERE store_key = 'checkout-v2'");
    await client.query("DELETE FROM customers WHERE email LIKE 'synthetic.checkout-v2.%@example.invalid'");
    await client.query("DELETE FROM stock_history WHERE user_name = 'checkout-v2-smoke'");
    await client.query("DELETE FROM promo_codes WHERE code LIKE 'SYNTH-%'");
    await client.query("DELETE FROM partners WHERE code LIKE 'SYNTH-%'");
    await client.query("DELETE FROM kwk_accounts WHERE email LIKE 'synthetic.%@example.invalid'");
    await client.query("DELETE FROM articles WHERE sku LIKE 'SYNTH-%'");
    await client.query("DELETE FROM shop_settings WHERE key LIKE 'promo_2for3_%'");

    await client.query(`
      INSERT INTO articles
        (sku, name, category, selling_price, sale_price, stock, min_stock, shop_product_id, shop_visible, is_active, categories, variants, short_description)
      VALUES
        ($1, $2, 'Peptide', '60.00', NULL, 20, 1, 'synthetic-visible', 1, 1, $3::jsonb, $4::jsonb, 'Synthetic visible peptide for isolated checkout-v2 smoke tests only.'),
        ($5, $6, 'Peptide', '75.00', NULL, 0, 1, 'synthetic-out-of-stock', 1, 1, $3::jsonb, $7::jsonb, 'Synthetic out-of-stock peptide for isolated checkout-v2 smoke tests only.'),
        ($8, $9, 'Peptide', '80.00', NULL, 20, 1, 'synthetic-hidden', 0, 1, $3::jsonb, $10::jsonb, 'Synthetic hidden peptide for isolated checkout-v2 smoke tests only.'),
        ($11, $12, 'Peptide', '4.00', NULL, 50, 1, 'bac-wasser-3ml', 1, 1, $13::jsonb, $14::jsonb, 'Synthetic free BAC gift 3 ml for isolated checkout-v2 smoke tests only.'),
        ($15, $16, 'Zubehör', '8.00', NULL, 50, 1, 'bac-wasser', 0, 1, $13::jsonb, $17::jsonb, 'Synthetic BAC component for isolated nasenspray-kit smoke tests only.'),
        ($18, $19, 'Peptide', '62.00', NULL, 20, 1, 'adamax', 1, 1, $20::jsonb, $21::jsonb, 'Synthetic Adamax kit-eligible item for isolated checkout-v2 smoke tests only.'),
        ($22, $23, 'Nasensprays', '95.00', NULL, 20, 1, 'synthetic-cold-chain', 1, 1, $24::jsonb, $25::jsonb, 'Synthetic cold-chain item for pickup restriction smoke tests only.')
    `, [
      "SYNTH-VISIBLE-10MG", "Synthetic Visible 10 mg", JSON.stringify(["Peptide"]), JSON.stringify([{ dosage: "10 mg", price: 60 }]),
      "SYNTH-OOS-10MG", "Synthetic Out Of Stock 10 mg", JSON.stringify([{ dosage: "10 mg", price: 75 }]),
      "SYNTH-HIDDEN-10MG", "Synthetic Hidden 10 mg", JSON.stringify([{ dosage: "10 mg", price: 80 }]),
      "SYNTH-BAC-3ML", "Synthetic BAC Wasser 3ml", JSON.stringify(["Peptide"]), JSON.stringify([{ dosage: "3ml", price: 4 }]),
      "SYNTH-BAC-10ML", "Synthetic BAC Wasser 10 ml", JSON.stringify([{ dosage: "10ml", price: 8 }]),
      "SYNTH-ADAMAX-10MG", "Synthetic Adamax 10 mg", JSON.stringify(["Peptide", "Nasensprays"]), JSON.stringify([{ dosage: "10 mg", price: 62 }]),
      "SYNTH-COLD-10MG", "Synthetic Cold Chain 10 mg", JSON.stringify(["Nasensprays"]), JSON.stringify([{ dosage: "10 mg", price: 95 }]),
    ]);

    await client.query(`
      INSERT INTO promo_codes (code, discount_type, percentage, fixed_amount, min_order, max_uses, current_uses, is_active, description)
      VALUES ('SYNTH-PROMO10', 'percent', '10.00', '0.00', '0.00', 0, 0, 1, 'Synthetic checkout-v2 isolated promo')
    `);
    await client.query(`
      INSERT INTO partners (name, email, code, partner_number, commission_percent, customer_discount_percent, credit_balance, commission_type, is_active, notes)
      VALUES ('Synthetic Partner', 'synthetic.partner@example.invalid', 'SYNTH-PARTNER10', 'SYNTH-P-1001', '10.00', '10.00', '25.00', 'dauerhaft', 1, '[SYNTHETIC_CHECKOUT_V2]')
    `);
    await client.query(`
      INSERT INTO kwk_accounts (kwk_number, referral_code, name, email, phone, password_hash, status)
      VALUES ('SYNTH-KWK-1001', 'SYNTH-KWK-REFERRAL', 'Synthetic Referrer', 'synthetic.referrer@example.invalid', '+49 151 11111111', 'synthetic-not-a-login', 'aktiv')
    `);
    await client.query(`
      INSERT INTO shop_settings (key, value)
      VALUES
        ('promo_2for3_enabled', 'true'),
        ('promo_2for3_mode', 'include'),
        ('promo_2for3_products', '["synthetic-visible"]'),
        ('address_validation_enabled', 'false')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function makeCustomer(suffix: string) {
  return {
    firstName: "Synthetic",
    lastName: `Checkout ${suffix}`,
    email: `synthetic.checkout-v2.${suffix}@example.invalid`,
    phone: "+49 151 23456789",
    street: "Musterstrasse",
    houseNumber: "1",
    zip: "50667",
    city: "Koeln",
    country: "Deutschland",
  };
}

async function main(): Promise<void> {
  const databaseUrl = requireIsolatedMode();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await resetSyntheticData(client);

    const caller = checkoutV2Router.createCaller({ req: { headers: {}, cookies: {} } } as never);

    const baseSelection = { shopProductId: "synthetic-visible", dosage: "10 mg", quantity: 1 };
    const quote = await caller.quote({ selections: [baseSelection], delivery: { country: "Deutschland", deliveryType: "home" } });
    assert.equal(quote.subtotal, 60);
    assert.equal(quote.shipping, 8);
    assert.equal(quote.discount, 0);
    assert.equal(quote.total, 68);
    assert.equal(quote.giftLines.length, 1);
    assert.equal(quote.giftLines[0].shopProductId, "bac-wasser-3ml");

    const manipulatedPriceQuote = await caller.quote({
      selections: [{ ...baseSelection, quantity: 2 }],
      delivery: { country: "Deutschland", deliveryType: "home" },
      code: "SYNTH-PROMO10",
      customer: { email: "synthetic.checkout-v2.promo@example.invalid", phone: "+4915123456789" },
    });
    assert.equal(manipulatedPriceQuote.subtotal, 120);
    assert.equal(manipulatedPriceQuote.discount, 12);
    assert.equal(manipulatedPriceQuote.total, 116);
    assert.ok(manipulatedPriceQuote.giftLines.some((line) => line.source === "promo_2for3" && line.quantity === 1));

    await assert.rejects(
      caller.quote({ selections: [{ shopProductId: "synthetic-hidden", dosage: "10 mg", quantity: 1 }], delivery: { country: "Deutschland", deliveryType: "home" } }),
      /Ein Produkt ist nicht mehr verfügbar/,
    );
    await assert.rejects(
      caller.quote({ selections: [{ shopProductId: "synthetic-out-of-stock", dosage: "10 mg", quantity: 1 }], delivery: { country: "Deutschland", deliveryType: "home" } }),
      /gewünschten Menge/,
    );
    await assert.rejects(
      caller.quote({ selections: [{ shopProductId: "synthetic-cold-chain", dosage: "10 mg", quantity: 1, isNasalSpray: true }], delivery: { country: "Deutschland", deliveryType: "packstation" } }),
      /Hausadresse erforderlich/,
    );
    await assert.rejects(
      caller.quote({ selections: [{ shopProductId: "synthetic-cold-chain", dosage: "10 mg", quantity: 1, isNasalSpray: true }], delivery: { country: "Deutschland", deliveryType: "postfiliale" } }),
      /Hausadresse erforderlich/,
    );
    await assert.rejects(
      caller.quote({
        selections: [baseSelection],
        delivery: { country: "Deutschland", deliveryType: "home" },
        code: "SYNTH-PARTNER10",
        kwkReferralCode: "SYNTH-KWK-REFERRAL",
        customer: { email: "synthetic.checkout-v2.combo@example.invalid", phone: "+4915123456789" },
      }),
      /Partner- und Empfehlungswege/,
    );
    await assert.rejects(
      caller.quote({
        selections: [baseSelection],
        delivery: { country: "Deutschland", deliveryType: "home" },
        partnerCredit: { requested: 1 },
      }),
      /Bitte melde dich als Partner an/,
    );

    const kitQuote = await caller.quote({
      selections: [{ shopProductId: "adamax", dosage: "10 mg", quantity: 1, isNasalDiySet: true }],
      delivery: { country: "Deutschland", deliveryType: "home" },
    });
    assert.equal(kitQuote.subtotal, 69);
    assert.equal(kitQuote.shipping, 8);
    assert.equal(kitQuote.coldChainRequired, false);

    const idempotencyKey = "synthetic-home-idempotency-key-0001";
    const completeInput = {
      selections: [baseSelection],
      delivery: { country: "Deutschland", deliveryType: "home" as const },
      customer: makeCustomer("complete"),
      paymentMethod: "SEPA" as const,
      idempotencyKey,
      acknowledgements: {
        researchOnly: true as const,
        ageConfirmed: true as const,
        noReturnConfirmed: true as const,
        addressConfirmed: true as const,
      },
    };
    const firstComplete = await caller.complete(completeInput);
    const secondComplete = await caller.complete(completeInput);
    assert.equal(firstComplete.success, true);
    assert.equal(secondComplete.orderId, firstComplete.orderId);

    const packstationInput = {
      ...completeInput,
      idempotencyKey: "synthetic-packstation-idempotency-0001",
      delivery: { country: "Deutschland", deliveryType: "packstation" as const },
      customer: { ...makeCustomer("packstation"), dhlPostNumber: "12345678" },
    };
    const packstationComplete = await caller.complete(packstationInput);
    assert.equal(packstationComplete.success, true);

    const postfilialeInput = {
      ...completeInput,
      idempotencyKey: "synthetic-postfiliale-idempotency-0001",
      delivery: { country: "Deutschland", deliveryType: "postfiliale" as const },
      customer: { ...makeCustomer("postfiliale"), dhlPostNumber: "87654321" },
    };
    const postfilialeComplete = await caller.complete(postfilialeInput);
    assert.equal(postfilialeComplete.success, true);

    const companyInput = {
      ...completeInput,
      idempotencyKey: "synthetic-company-idempotency-key-0001",
      customer: { ...makeCustomer("company"), company: "Synthetic Research GmbH" },
    };
    const companyComplete = await caller.complete(companyInput);
    assert.equal(companyComplete.success, true);

    const orderRows = await client.query("SELECT COUNT(*)::int AS count FROM orders WHERE checkout_idempotency_key = $1", [idempotencyKey]);
    assert.equal(orderRows.rows[0].count, 1);
    const addressRows = await client.query<{
      delivery_type: string;
      street: string;
      company: string | null;
      dhl_post_number: string | null;
    }>(`
      SELECT delivery_type, street, company, dhl_post_number
      FROM orders
      WHERE checkout_idempotency_key = ANY($1::text[])
      ORDER BY checkout_idempotency_key
    `, [[
      "synthetic-company-idempotency-key-0001",
      "synthetic-packstation-idempotency-0001",
      "synthetic-postfiliale-idempotency-0001",
    ]]);
    const byDeliveryType = new Map(addressRows.rows.map((row) => [row.delivery_type, row]));
    assert.equal(byDeliveryType.get("packstation")?.street, "Packstation");
    assert.equal(byDeliveryType.get("packstation")?.dhl_post_number, "12345678");
    assert.equal(byDeliveryType.get("postfiliale")?.street, "Postfiliale");
    assert.equal(byDeliveryType.get("postfiliale")?.dhl_post_number, "87654321");
    assert.equal(byDeliveryType.get("home")?.company, "Synthetic Research GmbH");
    const stockRows = await client.query("SELECT stock FROM articles WHERE sku = 'SYNTH-VISIBLE-10MG'");
    assert.equal(Number(stockRows.rows[0].stock), 16);

    console.log(JSON.stringify({
      ok: true,
      quoteTotal: quote.total,
      promoQuoteTotal: manipulatedPriceQuote.total,
      kitTotal: kitQuote.total,
      orderId: firstComplete.orderId,
      addressModes: ["home", "company", "packstation", "postfiliale"],
      externalEffects: "suppressed by CHECKOUT_V2_TEST_MODE=true",
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[Checkout V2 Commerce Staging Smoke] Failed:", error);
  process.exit(1);
});
