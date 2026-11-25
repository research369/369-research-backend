import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { orderMessageCents } from './orderDiscountMessageContract.js';
import { appendOrderDiscountHtml, appendOrderDiscountText, buildOrderDiscountMessagePresentation, futureCartDiscountNotice, stripManagedOrderDiscountBlock } from './orderDiscountMessagePresentation.js';
const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/order-discount-message-v1/synthetic.json', import.meta.url), 'utf8'));

for (const entry of fixture.cases) test(`synthetic golden: ${entry.id}`, () => {
  const original = structuredClone(entry.snapshot);
  for (const language of ['de', 'en'] as const) {
    const result = buildOrderDiscountMessagePresentation(entry.snapshot, language);
    for (const [key, expected] of Object.entries(entry.expected)) {
      if (key === 'deHero' || key === 'enHero') {
        if (key.startsWith(language)) assert.ok(result.text.includes(expected as string), `${key}: ${result.text}`);
      } else assert.equal((result as any)[key], expected, key);
    }
    assert.equal(result.fingerprint, buildOrderDiscountMessagePresentation(entry.snapshot, language === 'de' ? 'en' : 'de').fingerprint);
    assert.doesNotMatch(result.whatsapp, /\*\*|<table|NaN|Infinity/);
    assert.match(result.html, /style=/);
    if (result.productDiscountCents !== null && result.productDiscountCents > 0) {
      assert.match(result.html, /font-size:30px;font-weight:800/);
      assert.ok(result.text.includes(language === 'de' ? '🎉 DEIN RABATT' : '🎉 YOUR DISCOUNT'));
    }
  }
  assert.deepEqual(entry.snapshot, original);
});

test('strict money rejects unsafe/subcent/nonfinite/exponent and incomplete representations', () => {
  for (const value of [undefined, null, '', ' ', '1 ', ' 1', '-0', -1, '1e2', 1e21, '1.001', 1.001, '12,06 €', '12abc', NaN, Infinity, {}, '90071992547409.92']) assert.equal(orderMessageCents(value), null, String(value));
  for (const [value, cents] of [['0', 0], [0, 0], ['001.20', 120], [12.06, 1206], ['90071992547409.91', Number.MAX_SAFE_INTEGER]] as const) assert.equal(orderMessageCents(value), cents);
});

test('clean zero cannot hide invalid scalar, invalid row or positive credit', () => {
  const zero = { subtotal: 100, discount: 0, shipping: 5, total: 105 };
  for (const patch of [{ creditUsed: 'bad' }, { kwkCreditUsed: 10 }, { discountBreakdown: {} }]) assert.equal(buildOrderDiscountMessagePresentation({ ...zero, ...patch }).state, 'invalid');
});

test('optional malformed nominal percentage is not a monetary failure or added rate', () => {
  const base = fixture.cases[1].snapshot;
  const result = buildOrderDiscountMessagePresentation({ ...base, discountBreakdown: [{ source: 'promotion_code', amount: 56, percentage: '30%' }] });
  assert.equal(result.state, 'complete');
  assert.equal(result.productEffectiveRateBasisPoints, 2800);
  assert.deepEqual(result.reasons, ['invalid_nominal_percentage']);
});

test('untrusted labels/codes do not create HTML or WhatsApp markup; historical cancellation is qualified', () => {
  const result = buildOrderDiscountMessagePresentation({ ...fixture.cases[0].snapshot, status: 'storniert', discountCode: '<script>*fake*</script>', discountBreakdown: fixture.cases[0].snapshot.discountBreakdown.map((row: any) => ({ ...row, label: '<img src=x onerror=alert(1)>*fake*\u202e' })) });
  assert.doesNotMatch(result.html, /<script>|<img/);
  assert.doesNotMatch(result.whatsapp, /fake|\u202e/);
  assert.match(result.text, /Historische Anwendung/);
});

test('controlled managed block recomposition is exactly once, without deleting arbitrary prose', () => {
  const p = buildOrderDiscountMessagePresentation(fixture.cases[0].snapshot);
  const html = '<html><body><p>Mein eigener Rabatttext 99% bleibt redaktionell.</p></body></html>';
  const first = appendOrderDiscountHtml(html, p), second = appendOrderDiscountHtml(first, p);
  assert.equal(second, first);
  assert.equal((second.match(/order-discount-message\/v1:start/g) ?? []).length, 1);
  assert.match(second, /99% bleibt/);
  assert.equal(stripManagedOrderDiscountBlock(second), html);
  for (const channel of ['text', 'whatsapp'] as const) {
    const a = appendOrderDiscountText('Eigener Text 50% = 10€', p, channel);
    assert.equal(appendOrderDiscountText(a, p, channel), a);
    assert.doesNotMatch(a, /order-discount-message|\bstart\b|\bend\b|<[^>]*>/i);
    assert.equal((a.match(/\u2063\u200b\u2063/g) ?? []).length, 1);
    assert.equal((a.match(/\u2063\u200c\u2063/g) ?? []).length, 1);
    assert.doesNotMatch(a, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    assert.equal(stripManagedOrderDiscountBlock(a), 'Eigener Text 50% = 10€');
  }
});

test('managed legacy and invisible duplicates migrate without guessing financial prose', () => {
  const prose = 'Eigener Warenrabatt 99% = 999€; Guthaben 12€ bleibt redaktionell.';
  const p = buildOrderDiscountMessagePresentation(fixture.cases[0].snapshot);
  const oldVisible = '[order-discount-message/v1:start]\nOld financials\n[order-discount-message/v1:end]';
  const oldHtml = '<!-- order-discount-message/v1:start --><table><tr><td>Old financials</td></tr></table><!-- order-discount-message/v1:end -->';
  const invisible = '\u2063\u200b\u2063\nOld financials\n\u2063\u200c\u2063';
  const duplicated = `${prose}\n\n${oldVisible}\n\n${oldHtml}\n\n${invisible}\n\n${invisible}`;
  assert.equal(stripManagedOrderDiscountBlock(duplicated), prose);
  assert.equal(stripManagedOrderDiscountBlock(prose), prose);
  for (const language of ['de', 'en'] as const) for (const channel of ['text', 'whatsapp'] as const) {
    const current = buildOrderDiscountMessagePresentation(fixture.cases[0].snapshot, language);
    const composed = appendOrderDiscountText(duplicated, current, channel);
    assert.equal(composed, appendOrderDiscountText(prose, current, channel));
    assert.equal(appendOrderDiscountText(composed, current, channel), composed);
    assert.doesNotMatch(composed, /order-discount-message|\bstart\b|\bend\b|<[^>]*>|Old financials/i);
    const refreshed = appendOrderDiscountText(composed, p, channel);
    assert.equal(refreshed, appendOrderDiscountText(prose, p, channel));
  }
});

test('future basket disclaimer never invents euros or percentages', () => {
  for (const lang of ['de', 'en'] as const) {
    const text = futureCartDiscountNotice(lang);
    assert.doesNotMatch(text, /\d|%|€/);
    assert.ok(text.includes(lang === 'de' ? 'noch nicht bestimmbar' : 'cannot yet be determined'));
  }
});

test('partial with no classified product discount does not assert a complete zero discount', () => {
  const result = buildOrderDiscountMessagePresentation({ subtotal: 100, discount: 20, shipping: 5, total: 85, discountBreakdown: [{ source: 'unattributed', amount: 20 }] });
  assert.equal(result.state, 'partial');
  assert.match(result.text, /Kein Warenrabattanteil belegt/);
  assert.match(result.text, /vollständige Warenrabattquote ist unbekannt/);
  assert.doesNotMatch(result.text, /🎉/);
});
