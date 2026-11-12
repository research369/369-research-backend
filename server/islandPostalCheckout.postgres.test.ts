import test from "node:test";
import assert from "node:assert/strict";
import { isolatedOperationsDatabase } from "./operationsTestDatabase.js";
import { getPool, closeDb, withReadOnlyDatabase } from "./db.js";
import { orderRouter } from "./orderRouter.js";
import { defaultGlobalAutomaticDiscountConfig } from "./globalAutomaticDiscountConfig.js";
import { REVIEWED_ISLAND_POSTAL_RULES } from "./islandPostalRules.js";

const enabled = process.env.OPS_ISOLATED_REHEARSAL === "true";
test("reviewed island postcodes: actual handler permanently refuses cold before writes, normal shipping survives", { skip: !enabled }, async () => {
  assert.equal(process.env.DATABASE_URL, isolatedOperationsDatabase());
  const pool=await getPool();assert(pool);assert(REVIEWED_ISLAND_POSTAL_RULES.length>0,"No reviewed rules loaded");
  for(const [sku,name,category] of [["POSTAL-NASAL","Synthetic Nasenspray (10 mg)","Nasensprays"],["POSTAL-VIAL","Synthetic Vial (10 mg)","Peptide"]])
    await pool.query('INSERT INTO articles(sku,name,stock,shop_product_id,shop_visible,selling_price,category,is_active) VALUES($1,$2,100,$1,1,200,$3,1)',[sku,name,category]);
  await pool.query("INSERT INTO shop_settings(key,value) VALUES('address_validation_enabled','false') ON CONFLICT(key) DO UPDATE SET value='false'");
  const config={...defaultGlobalAutomaticDiscountConfig,percentage:36.9,startsAt:"2020-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z",exclusiveCampaign:true,freeShippingEnabled:true,freeShippingMinOrder:150,freeShippingRegions:["de","eu","ch"],coldShippingSurcharge:15,freeBacWaterPerPaidVial:true,stackWithPromotionCodes:false,stackWithPartnerCreatorCodes:false,stackWithKwk:false};
  const caller=orderRouter.createCaller({req:{headers:{}},res:{},user:null,operationsPreview:{}} as any);
  const admin=orderRouter.createCaller({req:{headers:{}},res:{},user:{id:99999,role:"admin",username:"local"},operationsPreview:{}} as any);
  const make=(sku:string,country:string,zip:string)=>({orderSource:"shop" as const,customer:{firstName:"Synthetic",lastName:"Postal",email:"postal@example.invalid",phone:"+491234567894",street:"Synthetic",houseNumber:"1",zip,city:"Untrusted city label",country},items:[{shopProductId:sku,name:"Forged cold-free label",dosage:"10 mg",variant:"10 mg",quantity:1,price:1,type:"peptide",isNasalSpray:false}],subtotal:1,discount:0,discountCode:null,shipping:0,shippingCountry:"de",total:1,paymentMethod:"SEPA" as const,date:"2026-11-12"});
  const counts=async()=>(await pool.query('SELECT (SELECT COUNT(*) FROM orders) orders,(SELECT COUNT(*) FROM stock_history) stock_history,(SELECT COUNT(*) FROM customers) customers,(SELECT COUNT(*) FROM customer_communications) communications')).rows[0];
  const before=await counts();const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("External requests forbidden");};
  try{
    for(const enabled of [false,true]){
      await pool.query("INSERT INTO shop_settings(key,value) VALUES('global_automatic_discount',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify({...config,enabled})]);
      for(const rule of REVIEWED_ISLAND_POSTAL_RULES){
        const length=rule.country==="PT"?7:5;
        const postal=rule.kind==="prefix"?rule.value.padEnd(length,"0"):rule.value;
        const zip=rule.country==="PT"?postal.slice(0,4)+"-"+postal.slice(4):postal;
        await assert.rejects(withReadOnlyDatabase(()=>caller.create(make("POSTAL-NASAL",rule.country,zip))),/KUEHLVERSAND_INSEL_AUSGESCHLOSSEN/);
        await assert.rejects(withReadOnlyDatabase(()=>caller.create({...make("POSTAL-VIAL",rule.country,zip),coldShippingRequested:true})),/KUEHLVERSAND_INSEL_AUSGESCHLOSSEN/);
        const standard:any=await withReadOnlyDatabase(()=>caller.create(make("POSTAL-VIAL",rule.country,zip)));
        assert.equal(standard.operationsPreview.subtotal,200);assert.equal(standard.operationsPreview.discount,enabled?73.8:0);assert.equal(standard.operationsPreview.total,enabled?126.2:200+(rule.country==="DE"?8:15));
      }
      for(const [country,zip] of [["DE","20354"],["CH","8880"],["CH","8400"],["CH","8001"],["FR","06000"],["AT","1010"],["ES","28001"],["IT","20100"],["PT","1000-001"]]){
        const result:any=await withReadOnlyDatabase(()=>caller.create(make("POSTAL-NASAL",country,zip)));assert.equal(result.operationsPreview.subtotal,200);assert.equal(result.operationsPreview.shipping,enabled?15:(country==="DE"?15:country==="CH"?25:22));
      }
    }
    const target=REVIEWED_ISLAND_POSTAL_RULES[0];const postal=target.kind==="prefix"?target.value.padEnd(target.country==="PT"?7:5,"0"):target.value;
    await assert.rejects(withReadOnlyDatabase(()=>caller.create({...make("POSTAL-NASAL",target.country,postal),shippingCountry:"Abholung"})),/KUEHLVERSAND_INSEL_AUSGESCHLOSSEN/);
    const pickup:any=await withReadOnlyDatabase(()=>admin.create({...make("POSTAL-NASAL",target.country,postal),orderSource:"wawi_manual",shippingCountry:"Abholung",subtotal:200,total:200,items:[{...make("POSTAL-NASAL",target.country,postal).items[0],price:200}]}));
    assert.equal(pickup.operationsPreview.shipping,0);
    assert.deepEqual(await counts(),before);assert.equal((await pool.query('SELECT MIN(stock) stock FROM articles')).rows[0].stock,100);
  }finally{globalThis.fetch=originalFetch;await closeDb();}
});
