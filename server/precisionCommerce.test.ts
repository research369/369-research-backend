import assert from "node:assert/strict";
import test from "node:test";
import { resolvePrecisionShopPrincipal, precisionReceiptFingerprint, PRECISION_COMMERCE_HEADER } from "./precisionCommercePrincipal.js";
import { PRECISION_CARTRIDGE_FAMILIES, PRECISION_NASAL_FAMILIES, precisionBac10 } from "./precisionCommercePolicy.js";
import { canonicalizeMainshopLines, assertMainshopStock, mainshopPolicySnapshot, type MainshopCatalogArticle } from "./mainshopCanonicalPricing.js";
const key = "synthetic-only-gateway-key-00000000000000000000";
const env = {PRECISION_COMMERCE_ENABLED: "true", PRECISION_COMMERCE_GATEWAY_KEY: key};
const req = (value: unknown = key) => ({headers: {[PRECISION_COMMERCE_HEADER]: value}});
function article(family = "semax", sku = "SYNTHETIC-10MG"): MainshopCatalogArticle {
  return {id: 1, sku, shopProductId: family, name: "Synthetic vial (10 mg)", sellingPrice: "20", salePrice: null, variants: [], isActive: 1, shopVisible: 1, stock: 20, category: "Peptide", categories: ["Peptide"]};
}
const bac = (): MainshopCatalogArticle => ({...article("bac-wasser", "SYNTHETIC-BAC-10ML"), id: 2, name: "Synthetic BAC Wasser (10 ml)", category: "Zubehör", categories: ["Zubehör"], sellingPrice: "5"});
const line = (family = "semax", flags: Record<string, boolean | undefined> = {isNasalSpray:true,isNasalDiySet:true}) => ({name:"Client name",shopProductId:family,dosage:"10 mg",type:"accessory",quantity:1,price:0.01,...flags});
test("precision principal ignores Origin/Referer/store claims without a key", () => {
  assert.equal(resolvePrecisionShopPrincipal({headers:{origin:"https://precision.example.test",referer:"https://precision.example.test",storeKey:"369research"}},env),undefined);
});
test("enabled key produces frozen server-owned principal", () => {
  const p=resolvePrecisionShopPrincipal(req(),env);assert.equal(p?.storeIdentity,"precision-shop");assert(Object.isFrozen(p));
});
for (const [label,value,config] of [
  ["wrong key", "x".repeat(44), env], ["short key", "short", env], ["array", [key], env], ["joined duplicate", `${key},${key}`, env], ["whitespace", ` ${key}`, env], ["disabled", key,{...env,PRECISION_COMMERCE_ENABLED:"false"}], ["missing enabled",key,{PRECISION_COMMERCE_GATEWAY_KEY:key}], ["weak configured secret",key,{...env,PRECISION_COMMERCE_GATEWAY_KEY:"short"}],
] as const) test(`failclosed principal: ${label}`,()=>assert.throws(()=>resolvePrecisionShopPrincipal(req(value),config),/PRECISION_COMMERCE_GATEWAY_UNAUTHORIZED/));
test("duplicate raw header and browser scope claims rejected",()=>{
  assert.throws(()=>resolvePrecisionShopPrincipal({...req(),rawHeaders:[PRECISION_COMMERCE_HEADER,key,PRECISION_COMMERCE_HEADER,key]},env),/UNAUTHORIZED/);
  assert.throws(()=>resolvePrecisionShopPrincipal({headers:{"x-369-precision-shop":"true"}},env),/SCOPE_CLAIM_INVALID/);
});
test("scope fingerprint deterministic and different from original",()=>{
  const digest="a".repeat(64);assert.notEqual(precisionReceiptFingerprint(digest),digest);assert.equal(precisionReceiptFingerprint(digest),precisionReceiptFingerprint(digest));assert.notEqual(precisionReceiptFingerprint(digest),precisionReceiptFingerprint("b".repeat(64)));
});
test("whitelists are exact 13 cartridge and 7 nasal families",()=>{
  assert.equal(PRECISION_CARTRIDGE_FAMILIES.size,13);assert.equal(PRECISION_NASAL_FAMILIES.size,7);
  assert(PRECISION_CARTRIDGE_FAMILIES.has("cagrilinitide"));assert(!PRECISION_CARTRIDGE_FAMILIES.has("cagrilintide"));assert(!PRECISION_CARTRIDGE_FAMILIES.has("klow-stack"));
});
for(const family of PRECISION_CARTRIDGE_FAMILIES) test(`canonical precision cartridge ${family} +15 and regular default unchanged`,()=>{
  const c=canonicalizeMainshopLines([line(family,{isPlugPlay:true})],[article(family)],[],[],undefined,true);assert.equal(c.items[0].price,35);assert.equal(c.items[0].canonicalProductId,family);assert(c.items[0].isPlugPlay);assert(!c.items[0].isNasalDiySet);assert.equal(c.quantityUnits,1);
});
for(const family of PRECISION_NASAL_FAMILIES) test(`canonical precision nasal ${family} +7 with one BAC10`,()=>{
  const a=article(family), b=bac(), c=canonicalizeMainshopLines([line(family)],[a,b],[],[],undefined,true);
  assert.equal(c.items[0].price,27);assert(c.items[0].isNasalSpray&&c.items[0].isNasalDiySet);assert(!c.items[0].isPlugPlay);assert.equal(c.items[1].shopProductId,b.sku);assert.equal(c.items[1].quantity,1);assert.equal(c.items[1].price,0);assert.equal(c.quantityUnits,1);
  assert.throws(()=>canonicalizeMainshopLines([line(family)],[a,b],[],[]),/NASAL_FORMAT_RETIRED/);
});
for(const flags of [{isNasalSpray:true},{isNasalDiySet:true},{isPlugPlay:true,isNasalSpray:true,isNasalDiySet:true}]) test(`contradictory/legacy precision format ${JSON.stringify(flags)}`,()=>assert.throws(()=>canonicalizeMainshopLines([line("semax",flags)],[article(),bac()],[],[],undefined,true),/FORMAT_INVALID/));
for(const family of ["klow-stack","cagrilintide","snap-8","unknown"]) test(`non-whitelisted cartridge ${family} rejected even if real vial`,()=>assert.throws(()=>canonicalizeMainshopLines([line(family,{isPlugPlay:true})],[article(family)],[],[],undefined,true),/FORMAT_UNSUPPORTED/));
test("real prepared nasal cannot be relabeled or converted to kit/vial",()=>{
  const a={...article(),name:"Synthetic prepared Nasenspray (10 mg)",category:"Nasensprays"};
  for(const flags of [{},{isNasalDiySet:true,isNasalSpray:true}])assert.throws(()=>canonicalizeMainshopLines([line("semax",flags)],[a,bac()],[],[],undefined,true),/PREPARED_NASAL_NOT_SELLABLE/);
});
test("canonical SKU-only selection allowed only through exact existing catalog publication",()=>{
  const a=article("tirzepatide","TI15");a.name="Synthetic vial (15 mg)";
  const c=canonicalizeMainshopLines([{...line("TI15",{isPlugPlay:true}),dosage:"15 mg"}],[a],[],[],undefined,true);assert.equal(c.items[0].shopProductId,"TI15");assert.equal(c.items[0].canonicalProductId,"tirzepatide");
  assert.throws(()=>canonicalizeMainshopLines([line("TI16",{isPlugPlay:true})],[a],[],[],undefined,true),/CATALOG/);
});
test("paid BAC10 plus kit BAC10 aggregate stock, no BAC3 replacement",()=>{
  const a=article(),b=bac();const items=canonicalizeMainshopLines([line(),{name:"paid",shopProductId:b.sku,dosage:"10 ml",quantity:1,price:0,type:"peptide"}],[a,b],[],[],undefined,true).items;
  b.stock=1;assert.throws(()=>assertMainshopStock(items,[a,b],true,true),/STOCK_DEMAND_NOT_COVERED/);b.stock=2;assert.equal(assertMainshopStock(items,[a,b],false,true).size,0);
  const wrong={...b,name:"Synthetic BAC Wasser 3ml",sku:"BAC-3ML"};assert.throws(()=>precisionBac10([wrong]),/BAC10_INVENTORY_REQUIRED/);
});
test("missing/duplicate/inactive BAC10 fails closed, snapshot includes tracked identity and price",()=>{
  const a=article(),b=bac();assert.throws(()=>precisionBac10([]),/BAC10/);assert.throws(()=>precisionBac10([b,{...b,id:3,sku:"DUP-10ML"}]),/BAC10/);assert.throws(()=>precisionBac10([{...b,isActive:0}]),/BAC10/);
  const snap=mainshopPolicySnapshot([line()],[a,b],[],[],true);assert.equal(snap.catalog.length,2);assert.equal(snap.storeIdentity,"precision-shop");
});
