import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assertManualSaleRole } from "./manualSaleAuthorization.js";
import { allowedBrowserOrigins, cookieRequestIsTrusted, guardCookieOrigin, retiredMailRelay } from "./requestSecurity.js";
import { resolveCheckoutCustomerDataChange } from "./customerDataChangeService.js";
import { promoCodeRouter } from "./promoCodeRouter.js";
import { orderRouter } from "./orderRouter.js";
const context = (role: string | null) => ({ req: { headers: {} }, res: {}, user: role ? { id: 1, username: "fixture", role, name: null, email: null } : null }) as any;
const customer = { id: 1, firstName: "Fixture", lastName: "One", email: "one@fixture.invalid", phone: "0171 1111111", street: "Old" };

test("F02 established sales roles only; guest shop remains permitted", () => {
  for (const role of ["admin", "packing"]) assert.doesNotThrow(() => assertManualSaleRole("wawi_manual", { role }));
  for (const role of ["product_manager", "customer", "partner", "unknown"]) assert.throws(() => assertManualSaleRole("wawi_manual", { role }), (e: any) => e.code === "FORBIDDEN");
  assert.throws(() => assertManualSaleRole("wawi_manual", null), (e: any) => e.code === "UNAUTHORIZED");
  assert.doesNotThrow(() => assertManualSaleRole("shop", null));
});
test("F02 actual order router rejects denied roles before database, pricing, or customer lookup", async () => {
  const input = { orderSource: "wawi_manual", items: [], customer: { firstName: "Fixture", lastName: "One", phone: "", email: "", street: "", houseNumber: "", zip: "", city: "", country: "" }, subtotal: 0, discount: 0, discountCode: null, shipping: 0, shippingCountry: "DE", total: 0, paymentMethod: "Bar", date: "2026-11-06" } as any;
  for (const role of [null, "product_manager", "unknown"]) await assert.rejects(orderRouter.createCaller(context(role)).create(input), (e: any) => ["FORBIDDEN", "UNAUTHORIZED"].includes(e.code));
});
test("F03 mixed duplicate email/unique phone and inverse both fail closed", () => {
  for (const records of [
    [customer, { ...customer, id: 2, phone: "0172 2222222" }],
    [customer, { ...customer, id: 2, email: "two@fixture.invalid" }],
  ]) assert.deepEqual(resolveCheckoutCustomerDataChange(records, customer), { kind: "no_unique_match", reason: "ambiguous", requiresConfirmation: false });
});
test("F03 names and SQL wildcard email patterns never broaden identity matching", () => {
  const r = resolveCheckoutCustomerDataChange([customer], { firstName: customer.firstName, email: "%@fixture.invalid", phone: "" });
  assert.equal(r.kind, "no_unique_match");
});
test("F06 exact first-party allowlist, documented configured preview, dev-only localhost", () => {
  const origins = allowedBrowserOrigins("https://known-preview.netlify.app,https://www.369research.eu/path,https://*.netlify.app", true);
  assert(origins.has("https://known-preview.netlify.app"));
  assert(!origins.has("http://localhost:5173"));
  assert(!origins.has("https://www.369research.eu/path"));
  assert(!origins.has("https://evil.netlify.app"));
  assert(allowedBrowserOrigins("", false).has("http://localhost:5173"));
});
test("F06 cookie writes need exact Origin, never referer-only or missing; trusted safe reads work", () => {
  const req = { headers: {}, method: "POST" } as any;
  assert.equal(cookieRequestIsTrusted(req), false);
  req.headers.referer = "https://www.369research.eu/wawi";
  assert.equal(cookieRequestIsTrusted(req), false);
  req.headers.origin = "https://www.369research.eu";
  assert.equal(cookieRequestIsTrusted(req), true);
  req.headers.origin = "https://www.369research.eu.evil.invalid";
  assert.equal(cookieRequestIsTrusted(req), false);
  delete req.headers.origin; req.method = "GET";
  assert.equal(cookieRequestIsTrusted(req), true);
});
test("F06 bearer programmatic API succeeds without Origin and cannot select ambient-cookie principal", () => {
  for (const origin of [undefined, "https://untrusted.invalid"]) {
    const req = { headers: { authorization: "Bearer synthetic-only", cookie: "369_session=old; 369_partner_session=old; preference=de", origin }, method: "POST" } as any;
    let advanced = false;
    guardCookieOrigin(req, { status: () => { throw Error("must not reject explicit bearer"); } } as any, () => { advanced = true; });
    assert(advanced); assert.equal(req.headers.cookie.trim(), "preference=de");
  }
});
test("F06 cross-origin/missing-Origin cookie requests are denied before auth", () => {
  for (const origin of [undefined, "https://untrusted.invalid"]) {
    let status = 0; let advanced = false;
    guardCookieOrigin({ headers: { cookie: "369_partner_session=synthetic-only", origin }, method: "POST" } as any, { status: (s: number) => { status = s; return { json() {} }; } } as any, () => { advanced = true; });
    assert.equal(status, 403); assert(!advanced);
  }
});
test("F05 retired backend mail relay does not inspect provider or body", () => {
  let status = 0;
  retiredMailRelay({ get body() { throw Error("body must not be read"); } } as any, { status: (s: number) => { status = s; return { json() {} }; } } as any, () => {});
  assert.equal(status, 410);
});
test("F10 legacy writers are side-effect-free; privacy query returns constant safe empty", async () => {
  const caller = promoCodeRouter.createCaller(context(null));
  for (let n = 0; n < 2; n++) {
    assert.deepEqual(await caller.incrementUsage({ code: "SYNTHETIC" }), { success: false, retired: true });
    assert.deepEqual(await caller.recordPartnerCodeUsage({ email: "one@fixture.invalid", partnerCode: "SYNTHETIC", orderId: "LOCAL-1" }), { success: false, retired: true });
    assert.deepEqual(await caller.checkPartnerCodeUsage({ email: "one@fixture.invalid" }), { hasUsed: false, partnerCode: null, usedAt: null, retired: true });
  }
});
test("F01 guest confirmation never has profile-write callsites; order audit remains and manual write is separate", () => {
  const source = readFileSync(new URL("./orderRouter.ts", import.meta.url), "utf8");
  const guest = source.slice(source.indexOf("        if (confirmedPublicChange)"), source.indexOf("        } else if (isAuthenticatedWawiManualSale"));
  assert(!guest.includes("update(customers)")); assert(guest.includes("persistConfirmedCustomerDataChange"));
  assert(!source.includes("toCustomerUpdateFromSnapshot"));
  assert(!source.includes("set({ communicationLanguage, updatedAt:"));
});
