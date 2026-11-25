import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';
import { Socket } from 'node:net';
if (process.env.SCREENSHOT_TEST_SANITIZED !== '1' || process.env.DATABASE_URL || process.env.RAILWAY_DB_URL || process.env.DOTENV_CONFIG_PATH !== '/dev/null') throw Error('SANITIZED_FIXTURE_REQUIRED');
// This pure suite cannot open ANY connection, including fixture PostgreSQL.
mock.method(globalThis, 'fetch', async () => { throw Error('NETWORK_FORBIDDEN'); });
mock.method(Socket.prototype, 'connect', () => { throw Error('SOCKET_FORBIDDEN'); });
const { assertNewNasalSale, isReadyNasalArticle, resolveNasalBacComponent, nasalDiySetAvailability } = await import('./nasalSalesPolicy.js');
const { normalizePublicCheckoutPricingOptions, resolveTrustedColdShippingItems } = await import('./coldShippingCatalog.js');
const { resolveAuthoritativeItemPrice, requiresColdChainShipping } = await import('./kwkCheckoutPricing.js');
const { reconcileFreeBacWaterForShopOrder } = await import('./freeBacWaterService.js');
const { screenshotCatalogProjection, screenshotSelection } = await import('./screenshotOrderInventory.js');
after(() => mock.restoreAll());
const row = (id: number, sku: string, name: string, shopProductId: string, category = 'Vials', stock = 20) => ({ id, sku, name, shopProductId, category, categories: [], stock, isActive: 1, shopVisible: 1, publishedAt: new Date('2026-01-01'), sellingPrice: 55, salePrice: null, variants: [] });
const catalog = [row(1,'SEMAX-10MG','Semax (10 mg)','semax'), row(2,'SELANK-10MG','Selank (10 mg)','selank','Vials',4), row(3,'BAC-10ML','BAC Wasser (10 ml)','bac-wasser','Zubehör'), row(4,'READY','Ready Nasenspray (10 mg)','ready','Nasensprays'), row(5,'READY-PP','Plug&Play Patrone (10 mg)','ready-pp','Fertigpens'), row(6,'CAPS','Capsules','caps','Kapseln / Tabletten'), row(7,'SERUM','Retinal Serum','serum','369 BeautyLine'), row(8,'EMPTY','Leere Nasensprayflasche','empty','Zubehör'), row(9,'FIXED-DIY','DIY Nasenspray Set komplett','fixed-diy','Nasensprays')];
const item = (shopProductId: string, extra: { name?: string; variant?: string; price?: number; isNasalSpray?: boolean; isNasalDiySet?: boolean } = {}) => ({ shopProductId, name:'Research vial', price:1, quantity:1, type:'peptide', ...extra });

test('new sales reject ready references/legacy request/name, never relabel or silently convert', () => {
  for (const selected of [item('READY'), item('ready',{isNasalSpray:false,isNasalDiySet:true}), item('semax',{isNasalSpray:true}), item('semax',{variant:'Bundle: ready Nasenspray'}), item('unknown',{name:'Ready Nasal Spray'})]) assert.throws(() => assertNewNasalSale([selected],catalog), /READY_NASAL_SALE_DISABLED/);
  assert.throws(() => assertNewNasalSale([item('caps',{isNasalDiySet:true})],catalog),/NASAL_DIY_OPTION_UNAVAILABLE/);
});
test('valid canonical and exact-SKU DIY accepts legacy dual flag; +7 once, unprepared, no free 3ml BAC', () => {
  for (const ref of ['semax','SEMAX-10MG']) {
    const raw=item(ref,{isNasalSpray:true,isNasalDiySet:true});assert.doesNotThrow(()=>assertNewNasalSale([raw],catalog));
    const [priced]=normalizePublicCheckoutPricingOptions([raw],catalog);assert.equal(resolveAuthoritativeItemPrice(priced,catalog),62);
    const [physical]=resolveTrustedColdShippingItems([priced],catalog);assert.equal(physical.isNasalDiySet,true);assert.equal(physical.isNasalSpray,true);assert.equal(requiresColdChainShipping(physical),false);
    assert.equal(reconcileFreeBacWaterForShopOrder([{...physical,price:62}],catalog).length,1);
  }
});
test('all six former nasal families expose only vial and DIY, no cartridge option or silent conversion', () => {
  for (const id of ['semax','selank','adamax','oxytocin','pt-141','kisspeptin-10']) {
    const selected=row(99,id.toUpperCase()+'-10MG',id+' (10 mg)',id);
    const rows=[selected,catalog[2]];
    const request={...item(selected.sku),isPlugPlay:true};
    assert.throws(()=>assertNewNasalSale([request],rows),/PRODUCT_FORM_UNAVAILABLE/);
    assert.throws(()=>assertNewNasalSale([item(selected.sku,{variant:'Plug&Play Patrone'})],rows),/PRODUCT_FORM_UNAVAILABLE/);
    assert.equal(normalizePublicCheckoutPricingOptions([request],rows)[0].isPlugPlay,false);
    assert(!screenshotCatalogProjection(rows).some(offer=>offer.form==='plug_play'));
    assert.doesNotThrow(()=>assertNewNasalSale([item(selected.sku,{isNasalDiySet:true,isNasalSpray:true})],rows));
  }
});
test('ordinary vials retain established 3ml entitlement and no included 10ml/bottle', () => {
  const raw=item('semax',{price:55});assert.doesNotThrow(()=>assertNewNasalSale([raw],catalog));
  const gifts=reconcileFreeBacWaterForShopOrder([raw],catalog);assert.equal(gifts.length,2);assert.equal(gifts[1].shopProductId,'bac-wasser-3ml');
  const c=screenshotCatalogProjection(catalog).find(c=>c.sku==='SEMAX-10MG'&&c.form==='vial')!;assert.deepEqual(c.componentLines,[]);assert.equal(c.stockDemands.length,1);
});
test('unrelated ready Plug&Play, capsules, cosmetics, empty bottle and complete DIY remain available', () => {
  for (const sku of ['READY-PP','CAPS','SERUM','EMPTY','FIXED-DIY']) assert.doesNotThrow(()=>assertNewNasalSale([item(sku,{name:catalog.find(a=>a.sku===sku)!.name})],catalog));
  const fixed=screenshotCatalogProjection(catalog).find(c=>c.sku==='FIXED-DIY')!;assert.equal(fixed.price,55);assert.equal(fixed.isNasalDiySet,true);assert.deepEqual(fixed.componentLines,[]);
  assert.equal(isReadyNasalArticle(catalog[3]),true);assert.equal(isReadyNasalArticle(catalog[8]),false);
});
test('BAC identity must be unique, active, tracked correct 10ml; never first-row/3ml fallback', () => {
  const bac=catalog[2];assert.equal(resolveNasalBacComponent(catalog).sku,'BAC-10ML');
  for (const rows of [[],[{...bac,isActive:0}],[{...bac,stock:NaN}],[{...bac,name:'BAC Wasser 3 ml',sku:'BAC-3ML'}],[{...bac,name:'BAC Wasser 3 ml'}],[bac,{...bac,id:99,isActive:0}],[{...bac,shopProductId:'bac-wasser-3ml'}]]) assert.throws(()=>resolveNasalBacComponent(rows),/COMPONENT_INVENTORY_UNAVAILABLE/);
});
test('public availability emits exact vial/BAC demands, shared BAC 4+16 valid without false minimum-vial cap', () => {
  const semax=nasalDiySetAvailability('SEMAX-10MG',catalog).nasalDiySet!,selank=nasalDiySetAvailability('SELANK-10MG',catalog).nasalDiySet!;
  assert.deepEqual(semax,{eligible:true,inStock:true,stock:20,surcharge:7,stockDemands:[{sku:'SEMAX-10MG',quantity:1,stock:20},{sku:'BAC-10ML',quantity:1,stock:20}]});
  assert.equal(selank.stock,4);const grouped=new Map<string,number>();for (const [a,q] of [[semax,16],[selank,4]] as const)for(const d of a.stockDemands)grouped.set(d.sku,(grouped.get(d.sku)??0)+d.quantity*q);assert.equal(grouped.get('BAC-10ML'),20);
  assert.deepEqual(nasalDiySetAvailability('CAPS',catalog),{});
  for (const rows of [catalog.filter(a=>a.sku!=='BAC-10ML'),catalog.map(a=>a.sku==='BAC-10ML'?{...a,isActive:0}:a),[...catalog,{...catalog[2],id:99}]]) { const a=nasalDiySetAvailability('SEMAX-10MG',rows).nasalDiySet!;assert.equal(a.stock,0);assert.equal(a.inStock,false);assert.deepEqual(a.stockDemands,[]); }
});
test('screenshot nasal is DIY only, full component sum includes separately bought BAC and quantity limits', () => {
  const c=screenshotCatalogProjection(catalog);assert(!c.some(a=>a.sku==='READY'));
  assert(c.filter(a=>a.form==='nasal').every(a=>a.isNasalDiySet));
  const result=screenshotSelection(c,[{sku:'SEMAX-10MG',quantity:16,form:'nasal'},{sku:'SELANK-10MG',quantity:4,form:'nasal'}]);assert.equal(result.stockPlan.find(a=>a.sku==='BAC-10ML')!.quantity,20);assert.equal(result.componentLines.length,6);
  assert.throws(()=>screenshotSelection(c,[{sku:'SEMAX-10MG',quantity:16,form:'nasal'},{sku:'SELANK-10MG',quantity:4,form:'nasal'},{sku:'BAC-10ML',quantity:1}]),/STOCK_UNAVAILABLE/);
  assert.throws(()=>screenshotSelection(c,[{sku:'READY',quantity:1,form:'nasal'}]),/EXACT_PUBLISHED_SKU_REQUIRED/);
});
test('historical shipping helper still recognizes ready flags/text and source objects remain unchanged', () => {
  const historical={name:'Ready Nasenspray',isNasalSpray:true,isNasalDiySet:false,price:115};const before={...historical};assert.equal(requiresColdChainShipping(historical),true);assert.deepEqual(historical,before);
});

test('PePGPT new offer projection never recommends ready sprays or maps a ready inventory variant', async () => {
  const { projectOffers } = await import('./pepgptOffers.js');
  const source = catalog.map(a => ({ id:a.id,name:a.name,sku:a.sku,shop_product_id:a.shopProductId,selling_price:String(a.sellingPrice),sale_price:null,stock:a.stock,category:a.category,is_active:a.isActive,shop_visible:a.shopVisible,variants:[{label:'10 mg',inventoryArticleId:a.id,price:a.sellingPrice}] }));
  assert.equal(projectOffers(source.filter(a=>a.sku==='READY'),[],null,{search:'Ready Nasenspray',quantity:1,country:'DE'},new Date()).offers.length,0);
  for (const name of ['Semax','Plug&Play Patrone','Capsules','Retinal Serum']) assert(projectOffers(source,[],null,{search:name,quantity:1,country:'DE'},new Date()).offers.length>0);
});
test('invalid manual type cannot opt out of the vial demand for a selected DIY kit', () => {
  for (const type of ['accessory', '']) assert.throws(()=>assertNewNasalSale([{...item('semax',{isNasalDiySet:true,isNasalSpray:true}),type}],catalog),/NASAL_DIY_OPTION_UNAVAILABLE/);
});
// Reviewed pure function suites, run under this process's global connection block.
await import('./freeBacWaterService.test.js');
await import('./kwkCheckoutPricing.test.js');
await import('./coldShippingCatalog.test.js');
