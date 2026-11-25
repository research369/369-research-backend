import test from "node:test";
import assert from "node:assert/strict";
import { isolatedOperationsDatabase } from "./operationsTestDatabase.js";
import { getPool, closeDb, withReadOnlyDatabase } from "./db.js";
import { orderRouter } from "./orderRouter.js";
import { defaultGlobalAutomaticDiscountConfig } from "./globalAutomaticDiscountConfig.js";

const enabled = process.env.OPS_ISOLATED_REHEARSAL === "true";
test("real checkout handler: BF prices, no-code enforcement, island refusal, expiry and zero writes", { skip: !enabled }, async () => {
  assert.equal(process.env.DATABASE_URL, isolatedOperationsDatabase());
  const pool = await getPool(); assert(pool);
  const base = { ...defaultGlobalAutomaticDiscountConfig, enabled: true, percentage: 36.9, startsAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", freeShippingEnabled: true, freeShippingMinOrder: 150, freeShippingRegions: ["de", "eu", "ch"], exclusiveCampaign: true, coldShippingSurcharge: 15, freeBacWaterPerPaidVial: true, stackWithPromotionCodes: false, stackWithPartnerCreatorCodes: false, stackWithKwk: false };
  const upsert = async (config: unknown) => pool.query("INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(config)]);
  for (const [sku, name, price, category] of [["BF-VIAL", "Synthetic Vial (10 mg)", 200, "Peptide"], ["BF-NASAL", "Synthetic Nasenspray (10 mg)", 200, "Nasensprays"], ["BF-PEN", "Synthetic Plug&Play Pen", 30, "Zubehör"], ["BF-READY", "Synthetic Plug&Play Patrone (10 mg)", 115, "Peptide"], ["bac-wasser-3ml", "BAC Wasser 3ml", 3, "Zubehör"]] as const) {
    await pool.query("INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category,is_active) VALUES($1,$2,100,$1,1,$3,$4,1)", [sku, name, price, category]);
  }
  const taggedBioIds = ["bronchogen", "cardiogen", "cartalax"];
  for (const id of [...taggedBioIds, "semax", "selank"]) {
    const isBio = taggedBioIds.includes(id);
    const category = isBio ? "Bio-Regulatoren" : "Cognitive & Neuroprotective";
    const categories = isBio
      ? [category, "Longevity & Mitochondrien", "Regeneration & Heilung", "Nasensprays"]
      : [category, "Nasensprays"];
    await pool.query("INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category,categories,is_active) VALUES($1,$2,100,$3,1,$4,$5,$6::jsonb,1)",
      [`${id.toUpperCase()}-${isBio ? "20" : "10"}MG`, `Synthetic ${id} (${isBio ? "20" : "10"} mg)`, id, isBio ? 39 : 100, category, JSON.stringify(categories)]);
  }
  await pool.query("INSERT INTO shop_settings(key,value) VALUES('address_validation_enabled','false') ON CONFLICT(key) DO UPDATE SET value='false'");
  await upsert(base);
  const caller = orderRouter.createCaller({ req: { headers: {} }, res: {}, user: null, operationsPreview: {} } as any);
  const make = (sku: string, country = "DE", zip = "10115", city = "Berlin") => ({
    orderSource: "shop" as const,
    customer: { firstName: "Synthetic", lastName: "Audit", email: "audit@example.invalid", phone: "+491234567891", street: "Teststrasse", houseNumber: "1", zip, city, country },
    items: [{ shopProductId: sku, name: "Browser fake name", dosage: "10 mg", variant: "10 mg", quantity: 1, price: 1, type: "peptide", isNasalSpray: false, isNasalDiySet: sku === "BF-NASAL" }],
    subtotal: 1, discount: 0, discountCode: null, shipping: 0, shippingCountry: "de", total: 1, paymentMethod: "SEPA" as const, date: "2026-11-12",
  });
  const counts = async () => (await pool.query("SELECT (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM stock_history) AS stock_history,(SELECT COUNT(*) FROM customers) AS customers,(SELECT COUNT(*) FROM customer_communications) AS communication")).rows[0];
  const before = await counts();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("External calls forbidden in isolated test"); };
  try {
    const result: any = await withReadOnlyDatabase(() => caller.create(make("BF-VIAL")));
    assert.equal(result.operationsPreview.subtotal, 200);
    assert.equal(result.operationsPreview.discount, 73.8);
    assert.equal(result.operationsPreview.shipping, 0);
    assert.equal(result.operationsPreview.total, 126.2);
    const taggedCart = {
      ...make("bronchogen"),
      items: taggedBioIds.map((id) => ({ ...make(id).items[0], name: `Synthetic ${id}`, dosage: "20 mg", variant: "20 mg", isNasalDiySet: false })),
    };
    const tagged: any = await withReadOnlyDatabase(() => caller.create(taggedCart));
    assert.equal(tagged.operationsPreview.subtotal, 117);
    assert.equal(tagged.operationsPreview.shipping, 8); // below 150: base only, never +15 cooling
    assert.equal(tagged.operationsPreview.items.filter((line: any) => taggedBioIds.includes(line.shopProductId)).length, 3);
    assert(tagged.operationsPreview.items.every((line: any) => line.price === 39));
    const manipulated: any = await withReadOnlyDatabase(() => caller.create({
      ...taggedCart, items: taggedCart.items.map((line) => ({ ...line, isNasalSpray: true, isNasalDiySet: true })),
    }));
    assert.equal(manipulated.operationsPreview.subtotal, 117);
    assert.equal(manipulated.operationsPreview.shipping, 8);
    // An availability tag must not activate cooling even on an island route.
    const taggedIsland: any = await withReadOnlyDatabase(() => caller.create({
      ...taggedCart, customer: make("bronchogen", "GB", "SW1A 1AA", "London").customer,
    }));
    assert.equal(taggedIsland.operationsPreview.subtotal, 117);
    assert.equal(taggedIsland.operationsPreview.shipping, 15);
    const taggedFreeBase: any = await withReadOnlyDatabase(() => caller.create({
      ...taggedCart, items: taggedCart.items.map((line) => ({ ...line, quantity: 2 })),
    }));
    assert.equal(taggedFreeBase.operationsPreview.subtotal, 234);
    assert.equal(taggedFreeBase.operationsPreview.shipping, 0); // no forced cold fee above threshold either
    for (const id of ["semax", "selank"]) {
      const plain: any = await withReadOnlyDatabase(() => caller.create(make(id)));
      assert.equal(plain.operationsPreview.subtotal, 100);
      assert.equal(plain.operationsPreview.shipping, 8);
      const diy: any = await withReadOnlyDatabase(() => caller.create({
        ...make(id), items: [{ ...make(id).items[0], isNasalSpray: true, isNasalDiySet: true, isPlugPlay: true }],
      }));
      assert.equal(diy.operationsPreview.subtotal, 107); // only existing allowlisted +7 DIY option
      assert.equal(diy.operationsPreview.shipping, 8); // unmixed kit, not a ready spray
    }
    const readyNasal: any = await withReadOnlyDatabase(() => caller.create(make("BF-NASAL")));
    assert.equal(readyNasal.operationsPreview.subtotal, 200);
    assert.equal(readyNasal.operationsPreview.shipping, 15); // true catalogue spray is still mandatory cold
    await assert.rejects(withReadOnlyDatabase(() => caller.create({ ...make("BF-VIAL"), items: [...make("BF-VIAL").items, { ...make("BF-VIAL").items[0], price: 0, isFreeGift: true }] })), /SHOP_GRATISPOSITION_NICHT_AUTORISIERT/);
    const pen: any = await withReadOnlyDatabase(() => caller.create(make("BF-PEN")));
    assert.equal(pen.operationsPreview.subtotal, 30);
    assert.equal(pen.operationsPreview.shipping, 8);
    assert.equal(pen.operationsPreview.total, 26.93);
    const ready: any = await withReadOnlyDatabase(() => caller.create({ ...make("BF-READY"), items: [{ ...make("BF-READY").items[0], isPlugPlay: true }] }));
    assert.equal(ready.operationsPreview.subtotal, 115);
    assert.equal(ready.operationsPreview.shipping, 23);
    assert.equal(ready.operationsPreview.total, 95.56);
    assert.equal(ready.operationsPreview.items.some((line: any) => line.shopProductId === "bac-wasser-3ml"), false);
    const prepared: any = await withReadOnlyDatabase(() => caller.create({ ...make("BF-VIAL"), items: [{ ...make("BF-VIAL").items[0], variant: "Plug&Play Patrone", isPlugPlay: false }] }));
    assert.equal(prepared.operationsPreview.subtotal, 215);
    assert.equal(prepared.operationsPreview.shipping, 15);
    assert.equal(prepared.operationsPreview.total, 150.66);
    assert.equal(result.operationsPreview.items.filter((line: any) => line.shopProductId === "bac-wasser-3ml").length, 1);
    for (const attempt of [{ discountCode: "OTHER" }, { partnerCode: "CREATOR" }, { kwkCode: "REF" }, { kwkCreditUsed: 1 }, { creditUsed: 1 }]) {
      await assert.rejects(withReadOnlyDatabase(() => caller.create({ ...make("BF-VIAL"), ...attempt })), /exklusiv/);
    }
    await assert.rejects(withReadOnlyDatabase(() => caller.create(make("BF-NASAL", "GB", "SW1A 1AA", "London"))), /KUEHLVERSAND_INSEL_AUSGESCHLOSSEN/);
    const standardIsland: any = await withReadOnlyDatabase(() => caller.create(make("BF-VIAL", "GB", "SW1A 1AA", "London")));
    assert.equal(standardIsland.operationsPreview.total, 126.2);
    const admin = orderRouter.createCaller({ req: { headers: {} }, res: {}, user: { id: 99999, role: "admin", username: "local-test" }, operationsPreview: {} } as any);
    const pickupInput = { ...make("BF-NASAL", "GB", "SW1A 1AA", "London"), orderSource: "wawi_manual" as const, shippingCountry: "Abholung", subtotal: 200, total: 200, items: [{ ...make("BF-NASAL").items[0], price: 200 }] };
    const pickup: any = await withReadOnlyDatabase(() => admin.create(pickupInput));
    assert.equal(pickup.operationsPreview.shipping, 0);
    assert.equal(pickup.operationsPreview.total, 126.2);
    await assert.rejects(withReadOnlyDatabase(() => caller.create({ ...make("BF-NASAL", "GB", "SW1A 1AA", "London"), shippingCountry: "Abholung" })), /KUEHLVERSAND_INSEL_AUSGESCHLOSSEN/);
    // A public flag must not grant free shipping outside the campaign.
    await upsert({ ...base, expiresAt: "2020-01-02T00:00:00.000Z" });
    const expired: any = await withReadOnlyDatabase(() => caller.create({ ...make("BF-VIAL"), freeBaseShippingRequested: true }));
    assert.equal(expired.operationsPreview.discount, 0);
    assert.equal(expired.operationsPreview.shipping, 8);
    assert.equal(expired.operationsPreview.total, 208);
    assert.deepEqual(await counts(), before);
    assert.equal((await pool.query("SELECT MIN(stock) AS stock FROM articles")).rows[0].stock, 100);
  } finally {
    globalThis.fetch = originalFetch;
    await closeDb();
  }
});
