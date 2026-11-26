import assert from 'node:assert/strict';
import test from 'node:test';
import { partnerRouter } from './partnerRouter.js';
const caller = partnerRouter.createCaller({ req: { headers: {} }, res: {}, user: { id: 1, username: 'fixture', role: 'admin' } } as any);
test('manual new account creation rejects BEN number before database access', async () => {
  for (const partnerNumber of ['BEN-1234','ben-1234',' BEN-1234 ']) {
    await assert.rejects(caller.create({ name: 'Fixture', code: 'FIXTURE10', partnerNumber,
      commissionPercent: 10, customerDiscountPercent: 10 }), (e: any) => e.code === 'BAD_REQUEST' && /BEN-Präfix/.test(e.message));
  }
});
