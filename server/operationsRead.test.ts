import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { verifyOperationsActor } from './operationsAuth.js';
import { stockDiagnosis, inventorySql } from './operationsInventory.js';
import { orderHash } from './jarvyOrderContract.js';
const key = 'a'.repeat(64), now = Date.now();
const actor = { id: randomUUID(), username: 'test', role: 'viewer' };
function sign(body: any = {}, issuedAt = now, path = '/api/operations/inventory') { const p = Buffer.from(JSON.stringify({ actor, issuedAt, method: 'POST', path, bodyHash: orderHash(body) })).toString('base64url'); return 'Bearer ' + p + '.' + createHmac('sha256', key).update(p).digest('base64url'); }
test('request-bound assertion rejects changed body/path, expiry, wrong or absent key', () => { assert.deepEqual(verifyOperationsActor(sign(), 'POST', '/api/operations/inventory', {}, key, now), actor); for (const [header, path, body, k, t] of [[sign(), '/api/operations/history', {}, key, now], [sign(), '/api/operations/inventory', { id: 1 }, key, now], [sign({}, now - 31000), '/api/operations/inventory', {}, key, now], [sign(), '/api/operations/inventory', {}, 'b'.repeat(64), now], [sign(), '/api/operations/inventory', {}, '', now]])
    assert.equal(verifyOperationsActor(header as string, 'POST', path as string, body, k as string, t as number), null); });
test('stock diagnosis distinguishes sales, corrections, missing history and discrepancy', () => { const a = { stock: 0, movement_count: 1, last_movement: { type: 'verkauf', after: 0, at: '2026-09-30' } }; assert.equal(stockDiagnosis(a).code, 'sold_out'); assert.equal(stockDiagnosis({ ...a, last_movement: { ...a.last_movement, type: 'korrektur' } }).code, 'corrected_to_zero'); assert.equal(stockDiagnosis({ ...a, last_movement: null, movement_count: 0 }).code, 'no_movements'); assert.equal(stockDiagnosis({ ...a, last_movement: { ...a.last_movement, after: 3 } }).code, 'history_mismatch'); });
test('inventory read excludes customer identity, usernames and free-text history reasons', () => { assert.equal(/user_name|order_id|reason|customers|email/i.test(inventorySql), false); });
