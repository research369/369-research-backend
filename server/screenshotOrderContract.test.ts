import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { screenshotHash,screenshotIntentKey,signScreenshotQuote,verifyScreenshotQuote,screenshotQuoteInputSchema,screenshotDiscountSchema } from './screenshotOrderContract.js';
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
