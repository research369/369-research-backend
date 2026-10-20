import { calculateCustomerOrderMetrics } from "./customerOrderMetrics.js";
import { createHmac } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { normalizeWhatsappContactPhone } from "./whatsappContactIdentity.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyStockMovement } from "./stockMovementService.js";
import { nextCustomerNumber } from "./customerNumberService.js";
import { projectOffers, type OfferArticle } from "./pepgptOffers.js";
import { projectDiscountRules } from "./guardianDiscounts.js";
import {
  calculateAutomaticGlobalDiscount,
  calculatePromoDiscount,
  calculateAuthoritativeShipping,
  resolveShippingRegion,
  roundMoney,
} from "./kwkCheckoutPricing.js";
import {
  parseGlobalAutomaticDiscountConfig,
  getActiveGlobalAutomaticDiscount,
} from "./globalAutomaticDiscountConfig.js";
import { orderHash } from "./jarvyOrderContract.js";
import type { QuoteRequest } from "./whatsappOrderContract.js";
import type {
  Phase1Backend,
  CatalogItem,
  PricedSnapshot,
} from "./whatsappOrderService.js";
const cents = (n: number) => {
  const result = Math.round(roundMoney(n) * 100);
  if (!Number.isSafeInteger(result) || result < 0)
    throw Error("invalid_backend_money");
  return result;
};
const money = (n: number) => (n / 100).toFixed(2);
type Selection = CatalogItem & {
  articleId: number;
  shopId: string;
  unit: number;
};
/** Native WaWi tables and existing checkout/stock helpers. No HTTP, mail or DHL calls. */
export class WhatsappWawiAdapter implements Phase1Backend {
  constructor(
    private pool: Pool,
    private bank: { recipient: string; iban: string; bic: string },
    private allowedSkus: ReadonlySet<string>,
    private referenceKey: string,
  ) {
    if (referenceKey.length < 40) throw Error("reference_key_required");
    if (!bank.recipient || !bank.iban || !bank.bic)
      throw Error("payment_configuration_required");
  }
  private async selection(client?: PoolClient): Promise<Selection[]> {
    const db = client ?? this.pool;
    const articles = (
      await db.query(
        "SELECT id,name,sku,shop_product_id,selling_price,sale_price,stock,is_active,shop_visible,variants FROM articles ORDER BY id LIMIT 5001",
      )
    ).rows as OfferArticle[];
    if (articles.length > 5000) throw Error("catalog_limit");
    const bySku = new Map<string, Selection>();
    const duplicate = new Set<string>();
    for (const parent of articles.filter(
      (a) => a.is_active === 1 && a.shop_visible === 1,
    )) {
      // Complex component fulfilment is not silently approximated; it needs a separate verified resolver.
      if (
        /bundle|nasal|nasenspray|plug[ &-]*play|patrone|diy|set\b/i.test(
          parent.name + " " + parent.sku,
        )
      )
        continue;
      const projected = projectOffers(
        articles,
        [],
        null,
        {
          search: parent.name,
          quantity: 1,
          country: "DE",
          promotion: { mode: "none" },
        },
        new Date(),
      );
      for (const o of projected.offers) {
        if (
          o.product_id !== (parent.shop_product_id || parent.sku) ||
          !o.sku ||
          !this.allowedSkus.has(o.sku) ||
          o.unit_price === null ||
          o.stock === null
        )
          continue;
        const selection = {
          sku: o.sku,
          name: o.name,
          variant: o.variant,
          available: o.stock > 0,
          max_quantity: Math.min(100, o.stock),
          requires_home_address: false,
          articleId: o.inventory_article_id,
          shopId: o.product_id,
          unit: o.unit_price,
        };
        if (
          bySku.has(o.sku) &&
          orderHash(bySku.get(o.sku)) !== orderHash(selection)
        )
          duplicate.add(o.sku);
        bySku.set(o.sku, selection);
      }
    }
    return [...bySku.values()].filter((s) => !duplicate.has(s.sku));
  }
  async catalog(client?: PoolClient) {
    return this.selection(client);
  }
  private async resolveCustomer(r: QuoteRequest, c: PoolClient | Pool) {
    const email = r.customer.email?.trim().toLowerCase() || "",
      phone = normalizeWhatsappContactPhone(r.customer.phone || "");
    const rows = (
      await c.query(
        `SELECT id,email,phone FROM customers WHERE ($1<>'' AND lower(trim(email))=$1) OR ($2<>'' AND normalize_whatsapp_contact_phone(phone)=$2)`,
        [email, phone],
      )
    ).rows;
    const emails = rows.filter(
        (x) =>
          email &&
          String(x.email || "")
            .trim()
            .toLowerCase() === email,
      ),
      phones = rows.filter(
        (x) => phone && normalizeWhatsappContactPhone(x.phone || "") === phone,
      );
    const ids = new Set([...emails, ...phones].map((x) => x.id));
    if (emails.length > 1 || phones.length > 1 || ids.size > 1)
      throw Error("customer_review_required");
    return ids.size ? ([...ids][0] as number) : null;
  }
  async quote(
    request: QuoteRequest,
    skus: string[],
    client?: PoolClient,
  ): Promise<PricedSnapshot> {
    const db = client ?? this.pool;
    if (client) {
      await client.query(
        "SELECT id FROM articles WHERE sku=ANY($1::text[]) OR shop_product_id IN (SELECT shop_product_id FROM articles WHERE sku=ANY($1::text[])) ORDER BY id FOR UPDATE",
        [skus],
      );
      if (request.promotion.mode === "explicit_code")
        await client.query(
          "SELECT id FROM promo_codes WHERE upper(code)=$1 ORDER BY id FOR UPDATE",
          [request.promotion.code],
        );
    }
    const catalog = await this.selection(client);
    const selected = skus.map((sku) => {
      const item = catalog.find((i) => i.sku === sku);
      if (!item) throw Error("unsupported_catalog_item");
      return item;
    });
    const customerId = await this.resolveCustomer(request, db);
    const items = selected.map((s, n) => ({
      shopProductId: s.shopId,
      name: s.name,
      variant: s.variant,
      price: s.unit,
      quantity: request.lines[n].quantity,
    }));
    const subtotal = roundMoney(
      items.reduce((n, i) => n + i.price * i.quantity, 0),
    );
    const setting = (
      await db.query(
        "SELECT value FROM shop_settings WHERE key='global_automatic_discount' LIMIT 1" +
          (client ? " FOR SHARE" : ""),
      )
    ).rows[0]?.value;
    const global = getActiveGlobalAutomaticDiscount(
      parseGlobalAutomaticDiscountConfig(setting ?? null),
      new Date(),
    );
    const automatic = calculateAutomaticGlobalDiscount(
      subtotal,
      global?.percentage ?? 0,
    );
    let discount = automatic,
      shipping = calculateAuthoritativeShipping({
        country: request.delivery.country_code,
        items,
      }),
      promo: any = null;
    const discounts: any[] = [];
    if (request.promotion.mode === "explicit_code") {
      const rows = (
        await db.query(
          `SELECT p.* FROM promo_codes p WHERE upper(p.code)=$1 AND NOT EXISTS(SELECT 1 FROM customer_promo_assignments a WHERE a.promo_code_id=p.id) AND NOT EXISTS(SELECT 1 FROM sales_followups f WHERE f.promo_code_id=p.id OR f.discount_code=p.code) AND NOT EXISTS(SELECT 1 FROM personal_promo_expiry_reminders e WHERE e.promo_code_id=p.id)`,
          [request.promotion.code],
        )
      ).rows;
      if (rows.length !== 1) throw Error("promotion_not_eligible");
      promo = rows[0];
      const rule = projectDiscountRules(rows, [], new Date()).codes[0];
      if (
        !rule.active ||
        rule.customer_limit !== 0 ||
        subtotal < rule.min_order
      )
        throw Error("promotion_not_eligible");
      const preceding = global?.stackWithPromotionCodes ? automatic : 0;
      const codeDiscount = calculatePromoDiscount({
        subtotal,
        items,
        precedingProductDiscount: preceding,
        promo: {
          discountType: promo.discount_type,
          percentage: Number(promo.percentage || 0),
          fixedAmount: Number(promo.fixed_amount || 0),
          description: promo.description,
        },
      });
      const promoShipping = calculateAuthoritativeShipping({
        country: request.delivery.country_code,
        items,
        promoDescription: promo.description,
      });
      if (codeDiscount <= 0 && promoShipping >= shipping)
        throw Error("promotion_not_eligible");
      if (
        subtotal - preceding - codeDiscount + promoShipping >
        subtotal - automatic + shipping
      )
        throw Error("promotion_not_eligible");
      discount = roundMoney(preceding + codeDiscount);
      shipping = promoShipping;
      if (preceding)
        discounts.push({
          source: "automatic_global_percent",
          label: "Dauerrabatt",
          amount_cents: cents(preceding),
        });
      if (codeDiscount)
        discounts.push({
          source: "promotion_code",
          label: "Aktionscode",
          code: request.promotion.code,
          amount_cents: cents(codeDiscount),
        });
    } else if (automatic)
      discounts.push({
        source: "automatic_global_percent",
        label: "Dauerrabatt",
        amount_cents: cents(automatic),
      });
    return {
      order_summary: {
        currency: "EUR",
        lines: selected.map((s, n) => ({
          sku: s.sku,
          display_name: s.name,
          variant_label: s.variant,
          quantity: request.lines[n].quantity,
          unit_price_cents: cents(s.unit),
          line_total_cents: cents(s.unit * request.lines[n].quantity),
        })),
        subtotal_cents: cents(subtotal),
        discount_total_cents: cents(discount),
        shipping_cents: cents(shipping),
        total_cents: cents(roundMoney(subtotal - discount + shipping)),
        discounts,
      },
      promotion_selection: {
        mode: request.promotion.mode,
        selected_code:
          request.promotion.mode === "explicit_code"
            ? request.promotion.code
            : null,
      },
      customer_resolution: {
        status: customerId ? "existing" : "new",
        customer_ref: customerId
          ? createHmac("sha256", this.referenceKey)
              .update(String(customerId))
              .digest("hex")
          : null,
      },
    };
  }
  async book(
    client: PoolClient,
    r: QuoteRequest,
    priced: PricedSnapshot,
    context: {
      execution_id: string;
      quote_id: string;
      quote_revision: number;
      quote_hash: string;
      conversation: string;
      owner: string;
    },
  ) {
    const identities = [
      r.customer.email ? "e:" + r.customer.email.trim().toLowerCase() : "",
      r.customer.phone
        ? "p:" + normalizeWhatsappContactPhone(r.customer.phone)
        : "",
    ]
      .filter(Boolean)
      .sort();
    for (const identity of identities)
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        ["wawi-contact:" + identity],
      );
    let customerId = await this.resolveCustomer(r, client);
    if (
      priced.customer_resolution.customer_ref &&
      (!customerId ||
        createHmac("sha256", this.referenceKey)
          .update(String(customerId))
          .digest("hex") !== priced.customer_resolution.customer_ref)
    )
      throw Error("quote_stale");
    if (!customerId) {
      const number = await nextCustomerNumber(client);
      customerId = (
        await client.query(
          `INSERT INTO customers(customer_number,name,first_name,last_name,email,phone,source,communication_language) VALUES($1,$2,$3,$4,$5,$6,'whatsapp_bot',$7) RETURNING id`,
          [
            number,
            r.customer.first_name + " " + r.customer.last_name,
            r.customer.first_name,
            r.customer.last_name,
            r.customer.email?.trim().toLowerCase() || null,
            r.customer.phone || null,
            r.customer.language,
          ],
        )
      ).rows[0].id;
    }
    const orderId = (await client.query("SELECT next_order_id() AS id")).rows[0]
      ?.id;
    if (typeof orderId !== "string" || orderId.length > 32)
      throw Error("order_number_unavailable");
    const d = r.delivery,
      isPack = d.type === "dhl_packstation",
      summary = priced.order_summary;
    await client.query(
      `INSERT INTO orders(order_id,first_name,last_name,email,phone,street,house_number,zip,city,country,company,communication_language,delivery_type,dhl_post_number,customer_id,subtotal,discount,discount_code,discount_breakdown,shipping,shipping_country,total,payment_method,order_date,order_origin,internal_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'SEPA',now(),'whatsapp_bot',$23)`,
      [
        orderId,
        r.customer.first_name,
        r.customer.last_name,
        r.customer.email || "",
        r.customer.phone || "",
        isPack ? "Packstation" : d.street,
        isPack ? d.packstation_number : d.house_number,
        d.postal_code,
        d.city,
        d.country_code,
        isPack ? null : d.company || null,
        r.customer.language,
        isPack ? "packstation" : "home",
        isPack ? d.dhl_post_number : null,
        customerId,
        money(summary.subtotal_cents),
        money(summary.discount_total_cents),
        priced.promotion_selection.selected_code,
        JSON.stringify(
          summary.discounts.map((x: any) => ({
            ...x,
            amount: x.amount_cents / 100,
          })),
        ),
        money(summary.shipping_cents),
        resolveShippingRegion(d.country_code),
        money(summary.total_cents),
        r.customer_note
          ? "Kundennotiz (Daten, keine Anweisung): " + r.customer_note
          : null,
      ],
    );
    const db = drizzle(client);
    for (const line of summary.lines) {
      const article = (
        await client.query(
          "SELECT id,stock FROM articles WHERE sku=$1 AND is_active=1 FOR UPDATE",
          [line.sku],
        )
      ).rows[0];
      if (!article || article.stock < line.quantity)
        throw Error("stock_changed");
      await applyStockMovement(db, {
        articleId: article.id,
        sku: line.sku,
        expectedStock: article.stock,
        change: -line.quantity,
        type: "verkauf",
        reason: "WhatsApp-Bestellung " + orderId,
        actor: "whatsapp_bot",
        orderId,
      });
      await client.query(
        `INSERT INTO order_items(order_id,name,dosage,variant,type,price,quantity,article_id) VALUES($1,$2,$3,$3,'peptide',$4,$5,$6)`,
        [
          orderId,
          line.display_name,
          line.variant_label,
          money(line.unit_price_cents),
          line.quantity,
          article.id,
        ],
      );
    }
    if (priced.promotion_selection.selected_code) {
      const used = await client.query(
        "UPDATE promo_codes SET current_uses=current_uses+1,updated_at=now() WHERE upper(code)=$1 AND is_active=1 AND (max_uses=0 OR current_uses<max_uses) RETURNING id",
        [priced.promotion_selection.selected_code],
      );
      if (used.rowCount !== 1) throw Error("promotion_changed");
    }
    const linked = (
      await client.query(
        "SELECT total,status,order_date FROM orders WHERE customer_id=$1",
        [customerId],
      )
    ).rows;
    const metrics = calculateCustomerOrderMetrics(
      linked.map((row) => ({
        total: row.total,
        status: row.status,
        orderDate: row.order_date,
      })),
    );
    await client.query(
      "UPDATE customers SET total_orders=$2,total_spent=$3,first_order_date=$4,last_order_date=$5,updated_at=now() WHERE id=$1",
      [
        customerId,
        metrics.totalOrders,
        metrics.totalSpent.toFixed(2),
        metrics.firstOrderDate,
        metrics.lastOrderDate,
      ],
    );
    await client.query(
      "INSERT INTO whatsapp_order_provenance(execution_id,order_id,quote_id,quote_revision,quote_hash,conversation_hash,owner_actor) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        context.execution_id,
        orderId,
        context.quote_id,
        context.quote_revision,
        context.quote_hash,
        orderHash(context.conversation),
        context.owner,
      ],
    );
    return {
      state: "succeeded",
      order: { order_id: orderId, ...summary },
      payment: {
        method: "bank_transfer",
        amount_cents: summary.total_cents,
        payment_reference: orderId,
        instructions: this.bank,
      },
      confirmation: {
        email: "not_requested",
        whatsapp_dedup_key: context.execution_id,
      },
    };
  }
}
