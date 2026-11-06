import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allHardeningSchemasReady } from './releaseHardeningReadiness.js';
test('all four mandatory schema flags must be true; every incomplete combination stays closed',()=>{
  for(let mask=0;mask<16;mask++) assert.equal(allHardeningSchemasReady({
    orderIntegrityReady:!!(mask&1),permissionsSchemaReady:!!(mask&2),accountSecurityReady:!!(mask&4),partnerFinancialLedgerReady:!!(mask&8),
  }),mask===15);
});
test('index returns 503 for incomplete hardening and runs mandatory migrations after KWK bases',async()=>{
  const source=await readFile(new URL('./index.ts',import.meta.url),'utf8');
  assert.match(source,/if \(!allHardeningSchemasReady\(hardening\)\) return res\.status\(503\)/);
  assert.match(source,/startupState === "ready" && allHardeningSchemasReady\(releaseHardeningReadiness\(\)\)/);
  const base=source.indexOf('CREATE TABLE IF NOT EXISTS kwk_accounts');assert(base>0);
  for(const name of ['Permissions','AccountSecurity','PriorityOrderIntegrity','PartnerFinancial']) assert(source.indexOf(`await ensure${name}Schema();`)>base);
});
test('checkout exact shared auth recheck follows owner lock and precedes persisted owner and same-Tx debit',async()=>{
  const source=await readFile(new URL('./orderRouter.ts',import.meta.url),'utf8');
  assert(!source.includes('verifyKwkToken'));
  const lock=source.indexOf('await assertKwkCreditAvailable(db,kwkCreditAccountId,authoritativeKwkCredit,true)');
  const auth=source.indexOf('await getAuthenticatedKwkFromToken(input.kwkCreditToken, createPartnerCreditTransactionQueryClient',lock);
  const owner=source.indexOf('kwkCreditOwnerId: authoritativeKwkCredit',auth);
  const debit=source.indexOf('await redeemCreditInTransaction(',owner);
  assert(lock>0&&auth>lock&&owner>auth&&debit>owner);
  assert.match(source,/lockedAuth\.sessionVersion !== kwkSessionVersion/);
});

test('paired intent contract: only renewed confirmation/auth tokens are excluded, business fields remain bound',async()=>{
  const {checkoutFingerprint}=await import('./priorityOrderIntegrity.js');
  const base={items:[{name:'Synthetic',quantity:1,price:20}],customer:{email:'owner@example.test',street:'Local'},kwkCreditUsed:10,creditUsed:0,discount:10,subtotal:20,total:10,customerDataChangeConfirmationToken:'first',kwkCreditToken:'auth-first'};
  assert.equal(checkoutFingerprint(base),checkoutFingerprint({...base,customerDataChangeConfirmationToken:'renewed',kwkCreditToken:'auth-renewed'}));
  for(const changed of [{customer:{...base.customer,street:'Other'}},{kwkCreditUsed:11},{creditUsed:1},{discount:9},{subtotal:21},{total:11},{items:[{...base.items[0],quantity:2}]}]) assert.notEqual(checkoutFingerprint(base),checkoutFingerprint({...base,...changed}));
});
