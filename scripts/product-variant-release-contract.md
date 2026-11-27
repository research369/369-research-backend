# Additive variant release contract

This change performs no live writes or deployment itself.

`productAdmin.getVariantReleaseSnapshot` is a read-only query guarded by the unchanged `productManagerProcedure`.

```ts
{ shopProductId: string, masterArticleId?: number }
```

The optional master ID is checked against the sole active variants owner (or sole active article when there is no variants owner); it is not a fallback/override. Inactive same-slug archival articles are retained in the authoritative snapshot and never released. Response: `shopProductId`, `masterArticleId`, `master`, **all** `articles`, master `variants`, nullable master `seo`/`merchant`, **all** `translations`/`faqs`/`useCases`, raw `metadata` grouped by relation, `stockHistory`, `productSchemaStatus`, `rawDrafts`, `expectedSnapshotHash`, and family `auditLog`. The hash includes all product rows, metadata and journal rows but not audit history.

`productAdmin.releaseVariant` is a mutation under the same guard.

```ts
{
  shopProductId: string,
  masterArticleId: number, // original resolved master, e.g. ELONEXT253, not selected254
  requestKey: string, // persisted UUID, historical exact replay
  expectedSnapshotHash: string, // exact hash from fresh snapshot
  selected: {
    articleId: number | null, // null inserts ONE new strength
    sku: string, label: string, price: number, targetStock: number,
    imageUrl: string,
    composition: {
      totalMassMg: number, components: {name: string, massMg: number}[],
      volumeMl?: number, concentrationMgMl?: number, solvents?: string[]
    }
  },
  content?: {
    name: string, category: 'Vials', categories: string[], shortDescription: string,
    badge?: string, casNumber?: string | null, molecularWeight?: string | null,
    purity?: string | null,
    description: object, // kurztext/wirkung/fazit/risiko and RUO required;
                         // optional composition MUST equal selected composition
    seo: { seoTitle: string, seoDescription: string, canonical: string,
           imageAlt: string, ogImage: string },
    merchant: { merchantTitle: string, merchantDescription: string, brand: string,
                googleProductCategory: string | null, productType: string },
    faqs: {lang: 'de', question: string, answer: string}[] // 4–6 unique
  }
}
```

Content is required for hidden-draft families or incomplete legacy metadata. Full content creates missing master SEO/Merchant/DE only; no arbitrary metadata repair. Default chemistry and purity stay null; null purity requires `eigenschaften.reinheit: 'Chargennachweis ausstehend'`. Existing unselected master chemistry is preserved. Canonical URL must be `https://www.369research.eu/product/{stableSlug}`. URLs require HTTPS without credentials. EUR prices are finite positive exact cents; target stock is integer 0..2147483647. Component masses exactly sum to total and mg label; existing strength/SKU and draft composition cannot be converted.

Visible master families append selected existing/new inventory row and preserve unselected stock/prices/SKUs. Hidden all-draft families publish only the selected strength and promote it to the sole variants/metadata owner; old draft article rows remain hidden/unpriced/zero-stock. The former draft master's obsolete variants list is cleared; old full snapshots, social data and metadata are retained in mandatory audit `oldValue`.

Replay of `RELEASE_VARIANT` with identical requestKey/payload returns the historical receipt before current hash/stock checks and never restocks. Same key/different payload conflicts. Stale snapshots conflict after deterministic advisory/article/metadata/journal row locks. Selected stock is changed only by `applyStockMovement`; no journal is inserted for delta zero. All price/image/content/publication/metadata/stock/audit changes are one transaction. Unchanged finalized-route guards remain unchanged, and public variants retain `publicationStatus: 'finalized-draft'`.

Response includes `success`, `shopProductId`, resolved `masterArticleId`, `selectedArticleId`, approved `articleIds`, `remainingDraftArticleIds`, `variants`, `shopVisible:true`, `beforeSnapshotHash`, new `expectedSnapshotHash`, `validation`, and `stockMovements` (empty when stock delta zero).

## Smoke-verification boundaries outside this ownership scope

`articleRouter.ts` has not been modified. Its canonical variant mapper resolves the selected inventory IDs and current row stock correctly in local fixtures. Its aggregate `shopProducts.stock`/`shopArticle.stock`, however, still sum only visible master articles, not hidden approved inventory children; CARTENDON/KPV aggregate stock therefore does not represent the sum of available strengths. Do not fix this by setting the master stock to the family sum (that would corrupt actual inventory). Main should decide a narrow public-mapper correction and smoke-test it.

The legacy `shopArticleTranslations` route merges **all** same-slug article translations and uses only FAQ `active`, not current-layout `is_visible`. Promotion moves former active-master metadata to the selected master, so NEXUS/ELONEX draft descriptions do not remain on hidden rows. Inactive archived KPV metadata remains deliberately preserved; main should ensure public translation selection prefers the sole visible finalized master instead of merging archived metadata. The release service updates master DE but preserves other languages. No stock/image/content mutation to SOMATIDE is included.

Local checks: 15/15 actual isolated PostgreSQL release tests, 16/16 existing finalization regression tests, TypeScript `tsc --noEmit` clean, `git diff --check` clean. Current and legacy FAQ layouts plus nullable and technical-zero draft prices are covered. The repository build script only prints `No build step needed with tsx`; it is not a compiled deployment verification. The node_modules symlink is local/untracked and must not be staged. No commit, push, deployment, live API or live DB write was performed.
