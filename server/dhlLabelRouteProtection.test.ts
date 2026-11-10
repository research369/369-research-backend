import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('existing order list and detail expose only a read-only lifecycle summary without widening roles', () => {
 const source=fs.readFileSync(new URL('./orderRouter.ts',import.meta.url),'utf8');
 assert.equal((source.match(/dhlLabelLifecycle: dhlLabelLifecycle\.get/g)||[]).length,2);
 assert.ok(source.includes('getDhlLabelLifecycleForOrders(filteredOrders'));
 assert.ok(source.includes('order.trackingCarrier === "DHL" || order.trackingCarrier === "DHL_PENDING"'));
});
test('both current PDF routes check label usability; historical generation downloads stay independent', () => {
 const source=fs.readFileSync(new URL('./dhlExpressRouter.ts',import.meta.url),'utf8');
 assert.equal((source.match(/if \(!isDhlLabelLifecycleUsable\(lifecycle\)\)/g)||[]).length,2);
 assert.equal((source.match(/code: "LABEL_NOT_ACTIVE"/g)||[]).length,2);
 const generation=source.slice(source.indexOf('for (const [path, document]'));
 assert.ok(generation.includes('dhlOperations.document'));
 assert.ok(!generation.includes('isDhlLabelLifecycleUsable'));
});
