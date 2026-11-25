import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { screenshotHash,screenshotIntentKey,signScreenshotQuote,verifyScreenshotQuote,screenshotQuoteInputSchema,screenshotDiscountSchema,screenshotCustomerSchema } from './screenshotOrderContract.js';
if(process.env.SCREENSHOT_TEST_SANITIZED!=='1'||process.env.DATABASE_URL||process.env.DOTENV_CONFIG_PATH!=='/dev/null')throw Error('SANITIZED_FIXTURE_REQUIRED');
test('HMAC binds actor, draft, input, expiry and denies tampering',()=>{
 const draftId=randomUUID(),now=Date.now();const envelope={version:1 as const,actorId:1,draftId,expiresAt:now+5000,revision:randomUUID(),canonicalInput:{safe:'fixture'},expectedHash:'a'.repeat(64),sourceHash:'b'.repeat(64)};
 const token=signScreenshotQuote(envelope);assert.equal(verifyScreenshotQuote(token,1).draftId,draftId);
 assert.throws(()=>verifyScreenshotQuote(token,2),/QUOTE_INVALID/);
 assert.throws(()=>verifyScreenshotQuote(token.slice(0,-5)+'abcde',1),/QUOTE_INVALID/);
 assert.throws(()=>verifyScreenshotQuote(token,1,now+6000),/QUOTE_EXPIRED/);
 assert.equal(screenshotIntentKey(1,draftId).length,64);assert.notEqual(screenshotIntentKey(1,draftId),screenshotIntentKey(2,draftId));
 assert.notEqual(screenshotHash({revision:new Date('2020-01-01')}),screenshotHash({revision:new Date('2020-01-02')}));
 const secret=process.env.JWT_SECRET;try{process.env.JWT_SECRET='dev-secret';assert.throws(()=>signScreenshotQuote(envelope),/SECRET_REQUIRED/);}finally{process.env.JWT_SECRET=secret;}
});
test('discount values cent exact, no hidden fields or browser price overrides',()=>{
 assert(screenshotDiscountSchema.safeParse({mode:'amount',value:1.01}).success);
 assert(!screenshotDiscountSchema.safeParse({mode:'amount',value:1.001}).success);
 assert(!screenshotDiscountSchema.safeParse({mode:'percent',value:101}).success);
 assert(!screenshotDiscountSchema.safeParse({mode:'none',code:'HIDDEN'}).success);
 const input={draftId:randomUUID(),customer:{firstName:'Test',lastName:'Person',phone:'+4915112345678',street:'Test',houseNumber:'1',zip:'1010',city:'Wien',country:'AT',deliveryType:'home'},items:[{sku:'TEST',quantity:1}],discount:{mode:'none'},customerConfirmed:true};
 assert(screenshotQuoteInputSchema.safeParse(input).success);
 assert(!screenshotQuoteInputSchema.safeParse({...input,price:1}).success);
 assert(!screenshotQuoteInputSchema.safeParse({...input,existingCustomerId:1}).success);
 assert(!screenshotQuoteInputSchema.safeParse({...input,customerConfirmed:false}).success);
 assert(!screenshotQuoteInputSchema.safeParse({...input,items:[{sku:'TEST',quantity:1},{sku:'test',quantity:1}]}).success);
});
test('station contract requires location number, Postnummer and German ZIP/country without mixing home fields',()=>{
 const base={firstName:'Test',lastName:'Person',phone:'+4915112345678',street:'Packstation',houseNumber:'123',zip:'10115',city:'Berlin',country:'DE',deliveryType:'packstation',dhlPostNumber:'12345678'};
 for(const type of ['packstation','postfiliale']){
  const street=type==='packstation'?'Packstation':'Postfiliale';
  for(const country of ['DE','Deutschland','Germany']){
   const parsed=screenshotCustomerSchema.parse({...base,deliveryType:type,street:`${street.toLowerCase()} 123`,country,company:'Unrelated home company'});
   assert.equal(parsed.street,street);assert.equal(parsed.houseNumber,'123');assert.equal(parsed.country,'DE');assert.equal(parsed.company,undefined);
  }
  for(const extra of [{houseNumber:''},{houseNumber:'12a'},{houseNumber:'0'},{houseNumber:'123456'},{zip:'1010'},{zip:'ABCDE'},{country:'AT'},{dhlPostNumber:undefined},{dhlPostNumber:'12345'},{dhlPostNumber:'1234567890123'},{dhlPostNumber:'12x45678'},{street:'Home Street'},{street:`${street} 999`}])
   assert(!screenshotCustomerSchema.safeParse({...base,deliveryType:type,street,...extra}).success,JSON.stringify(extra));
 }
 assert(!screenshotCustomerSchema.safeParse({...base,deliveryType:'home'}).success);
 assert(!screenshotCustomerSchema.safeParse({...base,deliveryType:'home',street:'Home Street'}).success);
 assert(screenshotCustomerSchema.safeParse({...base,deliveryType:'home',street:'Home Street',dhlPostNumber:undefined}).success);
});
