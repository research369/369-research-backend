import type { PoolClient } from "pg";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import {
  quoteRequest,
  executeRequest,
  catalogSearch,
  signCatalog,
  verifyCatalog,
  type QuoteRequest,
} from "./whatsappOrderContract.js";
import { orderHash } from "./jarvyOrderContract.js";
import { IsolatedPhase1Store } from "./whatsappPhase1Store.js";
export type CatalogItem = {
  sku: string;
  name: string;
  variant: string;
  available: boolean;
  max_quantity: number;
  requires_home_address: boolean;
};
export type PricedSnapshot = {
  order_summary: {
    currency: "EUR";
    lines: Array<{
      sku: string;
      display_name: string;
      variant_label: string;
      quantity: number;
      unit_price_cents: number;
      line_total_cents: number;
    }>;
    subtotal_cents: number;
    discount_total_cents: number;
    shipping_cents: number;
    total_cents: number;
    discounts: unknown[];
  };
  promotion_selection: {
    mode: "none" | "explicit_code";
    selected_code: string | null;
  };
  customer_resolution: {
    customer_ref?: string | null;
    status: "existing" | "new" | "conflict" | "ambiguous" | "blocked";
  };
  [key: string]: unknown;
};
export interface Phase1Backend {
  catalog(client?: PoolClient): Promise<CatalogItem[]>;
  /** Backend-owned canonical checkout pricing; never accept client money or customer IDs. */
  quote(
    request: QuoteRequest,
    skus: string[],
    client?: PoolClient,
  ): Promise<PricedSnapshot>;
  book?(
    client: PoolClient,
    request: QuoteRequest,
    priced: PricedSnapshot,
    context: {
      execution_id: string;
      quote_id: string;
      quote_revision: number;
      quote_hash: string;
      conversation: string;
      owner: string;
    },
  ): Promise<any>;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const publicQuote = (q: any) => ({
  quote_id: q.id,
  quote_revision: q.revision,
  quote_hash: q.hash,
  expires_at: q.expires_at,
  confirmation_challenge_id: q.challenge,
  ...q.snapshot,
  required_action: "customer_confirm_order",
});
/** Test-only service. Production writes are impossible: store requires a disposable test DB. */
export class WhatsappOrderService {
  constructor(
    private store: IsolatedPhase1Store,
    private backend: Phase1Backend,
    private signingKey: string,
    private owner: { user: string; chat: string },
    private now = () => new Date(),
  ) {
    if (signingKey.length < 40) throw Error("signing_key_required");
  }
  async search(raw: unknown) {
    const req = catalogSearch.parse(raw);
    return {
      schema_version: "1",
      as_of: this.now().toISOString(),
      items: (await this.backend.catalog())
        .filter((i) =>
          (i.name + " " + i.sku + " " + i.variant)
            .toLowerCase()
            .includes(req.query.toLowerCase()),
        )
        .slice(0, req.limit)
        .map((i) => ({
          catalog_item_id: signCatalog(i.sku, this.signingKey),
          display_name: i.name,
          variant_label: i.variant,
          inventory_sku: i.sku,
          available: i.available,
          max_quantity: i.max_quantity,
          requires_home_address: i.requires_home_address,
          selection_note: null,
        })),
    };
  }
  private async price(request: QuoteRequest, client?: PoolClient) {
    const skus = request.lines.map((l) =>
      verifyCatalog(l.catalog_item_id, this.signingKey),
    );
    if (new Set(skus).size !== skus.length)
      throw Error("duplicate_catalog_item");
    const catalog = await this.backend.catalog(client);
    for (let n = 0; n < skus.length; n++) {
      const item = catalog.find((i) => i.sku === skus[n]);
      if (!item) throw Error("unsupported_catalog_item");
      if (!item.available || request.lines[n].quantity > item.max_quantity)
        throw Error("stock_changed");
      if (
        item.requires_home_address &&
        request.delivery.type === "dhl_packstation"
      )
        throw Error("delivery_type_not_allowed_for_cart");
    }
    const priced = await this.backend.quote(request, skus, client);
    if (!["existing", "new"].includes(priced.customer_resolution.status))
      throw Error("customer_review_required");
    const sum = priced.order_summary;
    const amounts = [
      sum.subtotal_cents,
      sum.discount_total_cents,
      sum.shipping_cents,
      sum.total_cents,
      ...sum.lines.flatMap((l) => [l.unit_price_cents, l.line_total_cents]),
    ];
    if (
      sum.lines.length !== skus.length ||
      sum.lines.some(
        (line, n) =>
          line.sku !== skus[n] ||
          line.quantity !== request.lines[n].quantity ||
          line.line_total_cents !== line.unit_price_cents * line.quantity,
      ) ||
      sum.lines.reduce((n, l) => n + l.line_total_cents, 0) !==
        sum.subtotal_cents ||
      sum.discount_total_cents > sum.subtotal_cents ||
      sum.total_cents !==
        sum.subtotal_cents - sum.discount_total_cents + sum.shipping_cents
    )
      throw Error("invalid_backend_summary");
    if (
      amounts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      sum.currency !== "EUR"
    )
      throw Error("invalid_backend_money");
    if (
      priced.promotion_selection.mode !== request.promotion.mode ||
      (request.promotion.mode === "none" &&
        priced.promotion_selection.selected_code !== null) ||
      (request.promotion.mode === "explicit_code" &&
        priced.promotion_selection.selected_code !== request.promotion.code)
    )
      throw Error("unexpected_promotion");
    return {
      request,
      priced,
      internal_payment_method: "SEPA",
      order_origin: "whatsapp_bot",
      email_requested: false,
    };
  }
  async quote(tenant: string, raw: unknown) {
    const request = quoteRequest.parse(raw);
    const snapshot = await this.price(request);
    const fingerprint = orderHash(snapshot);
    return this.store.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        tenant + request.bot_conversation_id + request.draft_id,
      ]);
      const prior = (
        await c.query(
          "SELECT * FROM wop_quotes WHERE tenant=$1 AND conversation=$2 AND draft_id=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE",
          [tenant, request.bot_conversation_id, request.draft_id],
        )
      ).rows[0];
      if (prior && prior.executed) throw Error("intent_already_executed");
      if (
        prior &&
        prior.fingerprint === fingerprint &&
        new Date(prior.expires_at) > this.now()
      )
        return publicQuote(prior);
      if (prior)
        await c.query(
          "UPDATE wop_quotes SET expires_at=$2,approval_hash=NULL,confirmation=NULL WHERE tenant=$1 AND conversation=$3 AND draft_id=$4",
          [tenant, this.now(), request.bot_conversation_id, request.draft_id],
        );
      const id = randomUUID(),
        revision = (prior?.revision ?? 0) + 1,
        expires = new Date(this.now().getTime() + 10 * 60000),
        challenge = randomUUID();
      const hash = orderHash({ id, revision, snapshot, expires });
      const row = (
        await c.query(
          "INSERT INTO wop_quotes(id,tenant,conversation,draft_id,revision,hash,snapshot,fingerprint,expires_at,challenge) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
          [
            id,
            tenant,
            request.bot_conversation_id,
            request.draft_id,
            revision,
            hash,
            { ...snapshot.priced, request },
            fingerprint,
            expires,
            challenge,
          ],
        )
      ).rows[0];
      return publicQuote(row);
    });
  }
  /** Called only by the trusted channel component after deterministic reply/message matching. Not a write-key HTTP endpoint. */
  async confirmCustomer(
    tenant: string,
    e: {
      quote_id: string;
      challenge: string;
      conversation: string;
      message_id: string;
      confirmed_at: string;
      verified_reply: boolean;
    },
  ) {
    if (
      !e.verified_reply ||
      !e.message_id ||
      !Number.isFinite(Date.parse(e.confirmed_at)) ||
      Date.parse(e.confirmed_at) > this.now().getTime()
    )
      throw Error("confirmation_not_verified");
    return this.store.transaction(async (c) => {
      const q = (
        await c.query(
          "SELECT * FROM wop_quotes WHERE id=$1 AND tenant=$2 FOR UPDATE",
          [e.quote_id, tenant],
        )
      ).rows[0];
      if (
        !q ||
        q.executed ||
        new Date(q.expires_at) <= this.now() ||
        q.challenge !== e.challenge ||
        q.conversation !== e.conversation
      )
        throw Error("confirmation_mismatch");
      if (q.confirmation) {
        if (q.confirmation.message_id !== e.message_id)
          throw Error("confirmation_already_bound");
        return;
      }
      await c.query("UPDATE wop_quotes SET confirmation=$2 WHERE id=$1", [
        q.id,
        e,
      ]);
    });
  }
  /** This method must only be reached after the trusted Telegram component validates the actual update. */
  async approveOwner(
    tenant: string,
    e: {
      quote_id: string;
      quote_hash: string;
      quote_revision: number;
      user: string;
      chat: string;
      private_chat: boolean;
      callback_verified: boolean;
    },
  ) {
    if (
      !e.private_chat ||
      !e.callback_verified ||
      e.user !== this.owner.user ||
      e.chat !== this.owner.chat
    )
      throw Error("owner_not_authorized");
    return this.store.transaction(async (c) => {
      const q = (
        await c.query(
          "SELECT * FROM wop_quotes WHERE id=$1 AND tenant=$2 FOR UPDATE",
          [e.quote_id, tenant],
        )
      ).rows[0];
      if (
        !q ||
        q.executed ||
        !q.confirmation ||
        q.hash !== e.quote_hash ||
        q.revision !== e.quote_revision ||
        new Date(q.expires_at) <= this.now()
      )
        throw Error("approval_mismatch");
      const token = randomBytes(32).toString("hex");
      await c.query(
        "UPDATE wop_quotes SET approval_hash=$2,approval_actor=$3 WHERE id=$1",
        [q.id, digest(token), e.user],
      );
      return { approval_token: token };
    });
  }
  async execute(tenant: string, raw: unknown) {
    const input = executeRequest.parse(raw);
    return this.store.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        input.execution_id,
      ]);
      const old = (
        await c.query("SELECT * FROM wop_executions WHERE id=$1", [
          input.execution_id,
        ])
      ).rows[0];
      if (old) {
        if (
          old.tenant !== tenant ||
          old.quote_id !== input.quote_id ||
          old.hash !== input.quote_hash
        )
          throw Error("idempotency_conflict");
        return old.result;
      }
      const q = (
        await c.query(
          "SELECT * FROM wop_quotes WHERE id=$1 AND tenant=$2 FOR UPDATE",
          [input.quote_id, tenant],
        )
      ).rows[0];
      if (
        !q ||
        q.hash !== input.quote_hash ||
        q.revision !== input.quote_revision
      )
        throw Error("quote_mismatch");
      if (q.executed) throw Error("quote_already_executed");
      if (new Date(q.expires_at) <= this.now()) throw Error("quote_stale");
      const conf = input.customer_confirmation;
      if (
        !q.confirmation ||
        q.challenge !== conf.confirmation_challenge_id ||
        q.confirmation.message_id !== conf.message_id ||
        q.confirmation.confirmed_at !== conf.confirmed_at ||
        q.approval_hash !== digest(input.owner_approval.approval_token)
      )
        throw Error("both_approvals_required");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        q.tenant + q.conversation + q.draft_id,
      ]);
      const intent = await c.query(
        "SELECT execution_id FROM wop_intents WHERE tenant=$1 AND conversation=$2 AND draft_id=$3",
        [tenant, q.conversation, q.draft_id],
      );
      if (intent.rows.length) throw Error("intent_already_executed");
      const snapshot = await this.price(q.snapshot.request, c);
      if (orderHash(snapshot) !== q.fingerprint) throw Error("quote_stale");
      let result: any;
      if (this.backend.book) {
        result = {
          ...(await this.backend.book(c, snapshot.request, snapshot.priced, {
            execution_id: input.execution_id,
            quote_id: q.id,
            quote_revision: q.revision,
            quote_hash: q.hash,
            conversation: q.conversation,
            owner: q.approval_actor,
          })),
          rehearsal_only: true,
        };
      } else {
        // Rehearsal side effects exclusively in test tables, all guarded in this transaction.
        for (const line of snapshot.priced.order_summary.lines) {
          const r = await c.query(
            "UPDATE wop_test_inventory SET stock=stock-$2 WHERE sku=$1 AND stock >= $2 RETURNING sku",
            [line.sku, line.quantity],
          );
          if (!r.rows.length) throw Error("stock_changed");
        }
        const promo = snapshot.priced.promotion_selection.selected_code;
        if (promo) {
          const r = await c.query(
            "UPDATE wop_test_promos SET used=used+1 WHERE code=$1 AND (max_uses=0 OR used<max_uses) RETURNING code",
            [promo],
          );
          if (!r.rows.length) throw Error("promotion_changed");
        }
        const id = randomUUID();
        await c.query(
          "INSERT INTO wop_test_orders(id,execution_id,snapshot,order_origin,payment_method) VALUES($1,$2,$3,'whatsapp_bot','SEPA')",
          [id, input.execution_id, snapshot],
        );
        result = {
          state: "succeeded",
          rehearsal_only: true,
          order: { order_id: "TEST-" + id, ...snapshot.priced.order_summary },
          payment: {
            method: "bank_transfer",
            payment_reference: "TEST-" + id,
            amount_cents: snapshot.priced.order_summary.total_cents,
          },
          confirmation: {
            email: "not_requested",
            whatsapp_dedup_key: input.execution_id,
          },
        };
      }
      await c.query(
        "INSERT INTO wop_executions(id,tenant,quote_id,hash,result) VALUES($1,$2,$3,$4,$5)",
        [input.execution_id, tenant, q.id, q.hash, result],
      );
      await c.query("INSERT INTO wop_intents VALUES($1,$2,$3,$4)", [
        tenant,
        q.conversation,
        q.draft_id,
        input.execution_id,
      ]);
      await c.query(
        "UPDATE wop_quotes SET executed=true,approval_hash=NULL WHERE id=$1",
        [q.id],
      );
      return result;
    });
  }
  async status(tenant: string, id: string) {
    const r = await this.store.pool.query(
      "SELECT result FROM wop_executions WHERE id=$1 AND tenant=$2",
      [id, tenant],
    );
    return r.rows[0]?.result ?? { state: "not_found" };
  }
}
