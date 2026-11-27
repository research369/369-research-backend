import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublicShopVariants, hasReleasedVariants, publicMetadataSelection, summarizeReleasedStock } from './articleRouter.js';
const variant=(id:number,stock:number,hidden=false)=>({articleId:id,sku:'SKU-'+id,dosage:id+' mg',label:id+' mg',price:40,stock,inStock:stock>0,hidden});
test('released families include exact linked hidden child inventory without changing master stock',()=>{
 const master={id:251,name:'CARTENDON (20 mg)',sku:'CARTENDON-20MG',shopProductId:'cartendon',stock:13,sellingPrice:'61.00',variants:[{sku:'CARTENDON-20MG',label:'20 mg',price:61,stock:15,inventoryArticleId:251,publicationStatus:'finalized-draft'},{sku:'CARTENDON-48MG',label:'48 mg',price:95,stock:9,inventoryArticleId:252,publicationStatus:'finalized-draft'}]};
 const inventory=[master,{id:252,sku:'CARTENDON-48MG',stock:9,shopProductId:'cartendon'}];
 const output=getPublicShopVariants(master,inventory);assert.deepEqual(output.map(v=>[v.price,v.stock,v.articleId]),[[61,13,251],[95,9,252]]);
 assert.deepEqual(summarizeReleasedStock(output),{stock:22,inStock:true});assert.equal(master.stock,13);
});
test('sold out master still offers available child strength',()=>assert.deepEqual(summarizeReleasedStock([variant(1,0),variant(2,9)]),{stock:9,inStock:true}));
test('duplicate links and hidden stock are not counted twice',()=>assert.deepEqual(summarizeReleasedStock([variant(1,4),variant(1,4),variant(2,100,true)]),{stock:4,inStock:true}));
test('empty finalized variants remain unbuyable',()=>assert.deepEqual(summarizeReleasedStock([]),{stock:0,inStock:false}));
test('negative or fractional stock cannot create public stock',()=>assert.deepEqual(summarizeReleasedStock([variant(1,-1),variant(2,0.5)]),{stock:0,inStock:false}));
test('metadata uses exact active visible finalized master instead of archived same-slug rows',()=>{
 const released=[{publicationStatus:'finalized-draft'}];
 assert.deepEqual(publicMetadataSelection([{id:21,shopVisible:0,isActive:0,variants:released},{id:108,shopVisible:1,isActive:1,variants:released},{id:270,shopVisible:0,isActive:1,variants:null}]),{finalized:true,articleIds:[108]});
});
test('promotion exposes only selected new master metadata',()=>assert.deepEqual(publicMetadataSelection([{id:248,shopVisible:0,isActive:1,variants:null},{id:249,shopVisible:0,isActive:1,variants:null},{id:271,shopVisible:1,isActive:1,variants:[{publicationStatus:'finalized-draft'}]}]),{finalized:true,articleIds:[271]}));
test('legacy non-finalized product translation selection remains unchanged',()=>assert.deepEqual(publicMetadataSelection([{id:1,shopVisible:1,isActive:1,variants:[{price:40}]},{id:2,shopVisible:0,isActive:1,variants:null}]),{finalized:false,articleIds:[1,2]}));
test('multiple released masters fail rather than leak mixed metadata',()=>assert.throws(()=>publicMetadataSelection([1,2].map(id=>({id,shopVisible:1,isActive:1,variants:[{publicationStatus:'finalized-draft'}]})))));
test('publication marker is exact and unknown drafts do not gain finalized behavior',()=>{assert.equal(hasReleasedVariants([{priceStatus:'open'}]),false);assert.equal(hasReleasedVariants(null),false);assert.equal(hasReleasedVariants([{publicationStatus:'finalized-draft'}]),true)});
test('new KPV strength never inherits the old master purity',()=>{
 const master={id:108,name:'KPV (10 mg)',sku:'KPV-10MG',shopProductId:'kpv',stock:10,sellingPrice:'40.00',purity:'99%',variants:[{sku:'KPV-10MG',label:'10 mg',price:40,stock:10,inventoryArticleId:108,publicationStatus:'finalized-draft'},{sku:'KPV-30MG',label:'30 mg',price:89,stock:9,inventoryArticleId:262,publicationStatus:'finalized-draft'}]};
 const output=getPublicShopVariants(master,[master,{id:262,sku:'KPV-30MG',stock:9,shopProductId:'kpv',purity:null}]);
 assert.deepEqual(output.map(v=>[v.sku,v.purity,v.price,v.stock]),[['KPV-10MG','99%',40,10],['KPV-30MG',null,89,9]]);
 assert.equal(master.purity,'99%');
});
test('unconfirmed released purity is explicitly unknown even with claimed master quality',()=>{
 const master={id:263,name:'NEXUS 4 (24 mg)',sku:'NEXUS-4-24MG',shopProductId:'nexus-4',stock:10,sellingPrice:'145.00',purity:null,variants:[{sku:'NEXUS-4-24MG',label:'24 mg',price:145,stock:10,inventoryArticleId:263,publicationStatus:'finalized-draft'}]};
 const output=getPublicShopVariants(master,[master]);
 assert.equal(output.length,1);assert.equal(output[0].purity,null);assert.equal(Object.hasOwn(output[0],'purity'),true);
});
test('legacy variants retain absence of variant-specific purity for backward compatibility',()=>{
 const master={id:1,name:'Legacy (10 mg)',sku:'LEGACY-10MG',shopProductId:'legacy',stock:4,sellingPrice:'40.00',variants:[{label:'10 mg',price:40,stock:4}]};
 const output=getPublicShopVariants(master,[master]);assert.equal(output.length,1);assert.equal(Object.hasOwn(output[0],'purity'),false);
});
