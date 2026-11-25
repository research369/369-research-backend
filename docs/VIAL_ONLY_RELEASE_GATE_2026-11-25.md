# 369 mainshop: vial-only / standard-shipping release gate

Date: 2026-11-25. Branch: `feature/vial-only-standard-shipping-2026-11-25`.

This is an isolated integration branch, not a production release. It integrates the previously secured server-checkout-parity branch with frontend main `9fe892a3566ecafe1a03dfcf09c15434dd8404d5` and backend main `0c741c5c84866d028d84e8dc68f58fd7e28ea391`. Main branches, hosted environments and production records are not changed by this work.

## Regular 369 customer contract

- Prepared nasal products and old nasal/DIY format flags are not sold or silently converted to vials. Real vial products with secondary nasal category tags remain vial products.
- A separately selected real accessory article is a separate paid catalog/stock position. No implicit kit, old format surcharge, or automatic BAC10 component is attached.
- Eligible vials retain normal free BAC3, quantity tiers and inventory-confirmed Smart Sub. Accessories do not count for the quantity tiers, receive free BAC, or use substitute stock.
- Prices, identities, variants, stock and images must come from the actual catalog. No real DIY SKU, price, stock, composition or image is invented.
- The regular 369 customer path uses standard regional shipping even if old cold-shipping flags are submitted. Plug&Play uses that same path. No public cold-shipping surcharge or cooling destination restriction is applied there.
- Server quote/hash, strong intent, locked revalidation, atomic order/stock/receipt/ledger writes and uncertain-outcome recovery remain mandatory. Success is derived from the persisted server receipt, not a subsequent UI/notification outcome.
- Historical orders and authorized legacy manual WaWi, P4P and Checkout V2 workflows remain separate. This is not a global migration of their historical/manual rules.

## Executed checks

The first-visit public shell now waits for explicit age/RUO entry consent before mounting product/cart dialogs. This prevents Radix dialogs from blocking the visible entry button; WaWi routing remains separate. Eight new boundary regressions cover absent/invalid/blocked storage, explicit confirmation and returning customers. Two additional copy/layout tests retain dynamic BAC value and prevent a narrow price-column wrap.

Final frontend: 81 Vitest files, 1,125 passing tests; TypeScript and isolated offline build passed. Native frontend contract/operations/generator tests: 130 passed. Preview finalization marks 74 HTML files noindex; absent Merchant approvals produce eight empty feeds.

Backend: general suite 712 passed / 41 existing skips / zero failures; targeted handlers 161 passed; actual isolated PostgreSQL suites priority 59, operations 18, partner ledger 24, manual screenshot orders 38 passed. TypeScript passed.

Actual local Express/tRPC plus disposable PostgreSQL HTTP checks: 11 passing groups including read-only quotes, standard shipping, explicit accessory/BAC parity, race/replay/conflict and transactional rollback/retry. Actual desktop and 390px mobile browser checkout reached the persisted order confirmation; database receipt, positions and stock journal matched the quote. Mobile entry consent and all four checkout confirmation labels were clicked normally, without forced clicks or direct storage manipulation. No horizontal checkout overflow or page errors. Reload preserved orders, positions, receipts and stock history exactly. Test products, prices and customers were explicitly synthetic and are not live catalog definitions.

## Mandatory release blockers

1. The shared legacy order API still accepts a browser-supplied `storeKey`. That field is not a verified shop principal. A coordinated trusted server-gateway migration is required before a safe release; CORS, Origin or Referer alone is not sufficient. P4P must not be unilaterally broken or reconfigured.
2. The product chat must confirm the real separate DIY article and any physical conversion of prepared products. Hidden draft articles must be checked before creating anything. A prepared item must not merely be relabeled in the browser.
3. Real hosting/authentication, payment configuration, mail delivery/failure reporting, DHL and production WaWi processing still require a separate authorized staging/launch acceptance. Local test mail remains `unknown` with no provider credential; payment instructions are absent. No provider success is asserted.
4. Historical/manual cold-shipping options are preserved for compatibility. Removing current manual WaWi options requires a coordinated operational change, not a rewrite of historical orders.
5. Existing legal consent/widerruf text is not a legal clearance or a guarantee that statutory consumer rights can be waived. The browser run tests persistence and UI only.

No production deployment, product update, customer email, payment or shipping label is authorized by this document.
