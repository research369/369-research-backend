# Partner customer-code and commission audit

The authenticated Operations Console can independently audit another customer's use of one selected public partner code. Code ownership is bound to the selected partner; inactive codes, self-order identity and credit/KWK mixing are rejected. Exact per-code rates and program policies are read from the canonical database. A concrete customer/email is mandatory for first-paid rules. It is a read-only operations preview, never an order or a payment.

The preview runs the public checkout code validator and canonical order calculation, reports disagreements, and calculates the commission with the existing ledger amount helpers. Commission is conditional on confirmed payment; no preview can prove a future booking. Existing normal commission ledger entries for the last 20 attributed customer-code orders are compared with stored order amounts and policies, never current rates. Missing, mismatched, duplicate and unconfirmed bookings are identified; legacy missing policy stays unknown. Refund/reversal and payout reconciliation are outside this normal-booking audit.

A shared paid-code-history query removes the old public validator discrepancy: paid_at and all paid fulfillment statuses including abgeholt are required, matching ledger gating. Creator repeat-use and individual code rates remain configured. Historical snapshots are unchanged.

Validation: TypeScript, complete UTC test suite (same timezone as CI), isolated loopback database rehearsal (operationsPartnerCode.test.ts included in CI), existing operations tests, Console security suite and UI walkthrough. The new rehearsal blocks external fetch and verifies preview order/ledger/stock/balance immutability; synthetic paid/unpaid bookings, once-only booking, first-paid exclusion and mismatch reporting use only the disposable ops_rehearsal database. No production business data is changed by acceptance.

## Automatic monitoring

The signed read-only `partner-audit` action discovers every partner directly (no name/number search filter), runs canonical checkout code/price/commission previews for each active code and configured program, and checks the entire attributed order history. New hypothetical email, existing paid-code customer, and self-user own/foreign email cases are exercised when applicable. No email addresses leave the backend report. One available canonical cart is used; arbitrary baskets and every customer's separate blocks are outside scope.

Normal ledger entries are checked against chronological first-paid entitlement and immutable order terms/overrides. Missing, duplicate, wrong-recipient, inconsistent snapshot and amount mismatches are errors; legacy unknown rules, orphan/reversed paid entries are review findings. A missing booking has a two-minute payment grace. Cancellation reversals are respected; current program rates never replace historical terms. Reads use database-enforced read-only transactions. Time/history/report bounds make a run incomplete, never green.

The Console runs this action every 60 seconds independently of the browser/Mac, persists its latest result atomically in its private mounted directory and polls the in-app warning banner every 10 seconds. Failed/stale/incomplete runs remain visibly uncertain and retain prior findings. It never repairs financial data or sends external messages.
