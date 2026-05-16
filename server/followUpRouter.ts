/**
 * Follow-Up Router – Cross-Sell Follow-ups nach Versand
 *
 * Logik:
 * - 7 Tage nach shipped_at wird automatisch ein Follow-up erstellt
 * - Nur 1 Follow-up pro Bestellung (unique constraint auf order_id)
 * - Keine Duplikate von Kunden-/Bestelldaten, nur Referenzen
 * - Rabattcode ONCEAGAIN (10%) wird automatisch angelegt falls nicht vorhanden
 */
import { z } from "zod";
import { eq, and, lte, isNull, desc, or, inArray, ne } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { ENV } from "./env.js";
import {
  salesFollowups,
  salesFollowupProducts,
  orders,
  orderItems,
  articles,
  customers,
  promoCodes,
} from "../drizzle/schema.js";

const RESEND_API_URL = "https://api.resend.com/emails";
const FOLLOWUP_CODE = "ONCEAGAIN";
const FOLLOWUP_DISCOUNT_PERCENT = 10;
const SHOP_BASE_URL = "https://www.369research.eu";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalisiert Telefonnummern auf +49-Format für WhatsApp-Links */
function normalizePhone(phone: string): string {
  if (!phone) return "";
  let p = phone.replace(/[\s\-\.\(\)\/]/g, "");
  if (p.startsWith("0049")) p = "+49" + p.slice(4);
  else if (p.startsWith("00")) p = "+" + p.slice(2);
  else if (p.startsWith("0")) p = "+49" + p.slice(1);
  else if (!p.startsWith("+")) p = "+49" + p;
  return p;
}

/** Stellt sicher dass der ONCEAGAIN-Code in der DB existiert */
async function ensureOnceAgainCode(db: any): Promise<void> {
  const existing = await db
    .select({ id: promoCodes.id })
    .from(promoCodes)
    .where(eq(promoCodes.code, FOLLOWUP_CODE))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(promoCodes).values({
      code: FOLLOWUP_CODE,
      discountType: "percent",
      percentage: String(FOLLOWUP_DISCOUNT_PERCENT),
      fixedAmount: "0",
      minOrder: "0",
      maxUses: 0, // unlimited
      currentUses: 0,
      isActive: 1,
      description: "Follow-up Cross-Sell Code – 10% Rabatt für Bestandskunden",
    });
    console.log(`[FollowUp] ONCEAGAIN Promo-Code angelegt`);
  }
}

/** Lädt alle Bestellungen eines Kunden (Matching: customerId → email → phone) */
async function getCustomerOrderHistory(db: any, order: any): Promise<any[]> {
  const conditions: any[] = [];

  // Primär: customer_id
  if (order.customerId) {
    conditions.push(eq(orders.customerId, order.customerId));
  }

  // Fallback: E-Mail
  const email = (order.email || "").toLowerCase().trim();
  const PLACEHOLDER_EMAILS = new Set([
    "keine@angabe.de", "noemail@noemail.de", "no@email.de",
    "noreply@noreply.de", "placeholder@placeholder.de", "test@test.de",
  ]);
  if (email && !PLACEHOLDER_EMAILS.has(email)) {
    conditions.push(eq(orders.email, order.email));
  }

  if (conditions.length === 0) {
    return [order]; // Nur die Ursprungsbestellung
  }

  const allOrders = await db
    .select()
    .from(orders)
    .where(or(...conditions))
    .orderBy(desc(orders.orderDate));

  // Deduplizieren nach orderId
  const seen = new Set<string>();
  return allOrders.filter((o: any) => {
    if (seen.has(o.orderId)) return false;
    seen.add(o.orderId);
    return true;
  });
}

/** Generiert WhatsApp-Nachricht */
function generateWhatsAppMessage(
  order: any,
  selectedArticles: any[],
  promoCode: string
): string {
  const firstName = order.firstName || order.first_name || "";
  const orderDate = order.orderDate
    ? new Date(order.orderDate).toLocaleDateString("de-DE")
    : "";

  const productLines = selectedArticles
    .map((a) => {
      const slug = a.shopProductId || "";
      const link = slug ? `${SHOP_BASE_URL}/product/${slug}` : SHOP_BASE_URL;
      const price = a.sellingPrice ? `${parseFloat(a.sellingPrice).toFixed(2).replace(".", ",")} €` : "";
      return `• ${a.name}${price ? ` (${price})` : ""}\n  ${link}`;
    })
    .join("\n");

  return `Hallo ${firstName},

wir hoffen, du bist zufrieden mit deiner Bestellung vom ${orderDate}! 🙏

Als Dankeschön für dein Vertrauen möchten wir dir heute einige Produkte vorstellen, die hervorragend zu deiner bisherigen Forschung passen könnten:

${productLines}

Mit dem Code *${promoCode}* erhältst du *${FOLLOWUP_DISCOUNT_PERCENT}% Rabatt* auf deine nächste Bestellung – einfach im Checkout eingeben.

Alle Produkte sind ausschließlich für In-vitro-Forschungszwecke bestimmt.

Bei Fragen stehen wir dir jederzeit zur Verfügung. 🔬

Viele Grüße,
Dein 369 Research Team`;
}

/** Generiert E-Mail-Betreff und -Body */
function generateEmailContent(
  order: any,
  selectedArticles: any[],
  promoCode: string
): { subject: string; body: string } {
  const firstName = order.firstName || order.first_name || "";
  const orderDate = order.orderDate
    ? new Date(order.orderDate).toLocaleDateString("de-DE")
    : "";

  const productRows = selectedArticles
    .map((a) => {
      const slug = a.shopProductId || "";
      const link = slug ? `${SHOP_BASE_URL}/product/${slug}` : SHOP_BASE_URL;
      const price = a.sellingPrice
        ? `${parseFloat(a.sellingPrice).toFixed(2).replace(".", ",")} €`
        : "";
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">
          <a href="${link}" style="color:#0040C1;text-decoration:none;font-weight:600;">${a.name}</a>
          ${a.category ? `<br><span style="color:#64748b;font-size:12px;">${a.category}</span>` : ""}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;white-space:nowrap;">${price}</td>
      </tr>`;
    })
    .join("");

  const subject = `Dein exklusives Angebot von 369 Research – ${FOLLOWUP_DISCOUNT_PERCENT}% Rabatt für dich`;

  const body = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <!-- Header -->
    <div style="background:#0A1628;padding:32px 40px;text-align:center;">
      <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;letter-spacing:-0.5px;">369 Research</h1>
      <p style="color:#6B9FFF;margin:8px 0 0;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;">Premium Research Peptides</p>
    </div>
    <!-- Body -->
    <div style="padding:40px;">
      <p style="color:#1A1A2E;font-size:16px;margin:0 0 8px;">Hallo ${firstName},</p>
      <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px;">
        wir hoffen, du bist zufrieden mit deiner Bestellung vom <strong>${orderDate}</strong>!
        Als Dankeschön für dein Vertrauen möchten wir dir heute einige Produkte vorstellen,
        die hervorragend zu deiner bisherigen Forschung passen könnten.
      </p>
      <!-- Products -->
      <h2 style="color:#1A1A2E;font-size:16px;font-weight:700;margin:0 0 16px;">Empfehlungen für dich</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#f7f9fc;">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Produkt</th>
            <th style="padding:8px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Preis</th>
          </tr>
        </thead>
        <tbody>${productRows}</tbody>
      </table>
      <!-- Promo Code -->
      <div style="background:#f0f7ff;border:2px dashed #0040C1;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
        <p style="color:#475569;font-size:14px;margin:0 0 8px;">Dein persönlicher Rabattcode</p>
        <p style="color:#0040C1;font-size:28px;font-weight:800;letter-spacing:0.1em;margin:0 0 8px;">${promoCode}</p>
        <p style="color:#475569;font-size:14px;margin:0;"><strong>${FOLLOWUP_DISCOUNT_PERCENT}% Rabatt</strong> auf deine nächste Bestellung</p>
      </div>
      <div style="text-align:center;margin-bottom:24px;">
        <a href="${SHOP_BASE_URL}" style="display:inline-block;background:#0040C1;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Jetzt shoppen →</a>
      </div>
      <!-- Disclaimer -->
      <p style="color:#94a3b8;font-size:12px;line-height:1.5;border-top:1px solid #f0f0f0;padding-top:16px;margin:0;">
        Alle Produkte sind ausschließlich für In-vitro-Forschungs- und Laborzwecke bestimmt.
        Nicht für den menschlichen oder tierärztlichen Verzehr.
      </p>
    </div>
    <!-- Footer -->
    <div style="background:#f7f9fc;padding:20px 40px;text-align:center;">
      <p style="color:#94a3b8;font-size:12px;margin:0;">369 Research · <a href="${SHOP_BASE_URL}" style="color:#0040C1;">www.369research.eu</a></p>
    </div>
  </div>
</body>
</html>`;

  return { subject, body };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const followUpRouter = router({
  /**
   * Erstellt fehlende Follow-ups für alle versendeten Bestellungen
   * die shipped_at + 7 Tage überschritten haben.
   * Wird beim Dashboard-Load aufgerufen (idempotent).
   */
  createMissingFollowUps: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await ensureOnceAgainCode(db);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Alle versendeten Bestellungen mit shipped_at <= 7 Tage ago
    const shippedOrders = await db
      .select({ orderId: orders.orderId, shippedAt: orders.shippedAt })
      .from(orders)
      .where(
        and(
          eq(orders.status, "versendet"),
          lte(orders.shippedAt, sevenDaysAgo)
        )
      );

    if (shippedOrders.length === 0) return { created: 0 };

    // Bestehende Follow-up order_ids laden
    const existingFollowUps = await db
      .select({ orderId: salesFollowups.orderId })
      .from(salesFollowups);
    const existingOrderIds = new Set(existingFollowUps.map((f: any) => f.orderId));

    let created = 0;
    for (const o of shippedOrders) {
      if (existingOrderIds.has(o.orderId)) continue;
      if (!o.shippedAt) continue;

      const dueAt = new Date(new Date(o.shippedAt).getTime() + 7 * 24 * 60 * 60 * 1000);

      try {
        await db.insert(salesFollowups).values({
          orderId: o.orderId,
          status: "pending",
          dueAt,
        });
        created++;
      } catch (err: any) {
        // unique constraint violation = already exists, skip
        if (!err.message?.includes("unique") && !err.message?.includes("duplicate")) {
          console.error(`[FollowUp] Failed to create follow-up for ${o.orderId}:`, err.message);
        }
      }
    }

    if (created > 0) {
      console.log(`[FollowUp] Created ${created} new follow-ups`);
    }

    return { created };
  }),

  /**
   * Listet alle fälligen Follow-ups mit Bestelldaten und Kundendaten
   */
  listDueFollowUps: adminProcedure
    .input(z.object({
      status: z.enum(["pending", "done", "skipped", "all"]).optional().default("pending"),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const now = new Date();

      // Follow-ups laden
      let followUpsQuery = db
        .select()
        .from(salesFollowups)
        .orderBy(desc(salesFollowups.dueAt));

      const allFollowUps = await followUpsQuery;

      // Filtern
      const filtered = allFollowUps.filter((f: any) => {
        if (input.status === "all") return true;
        return f.status === input.status;
      });

      if (filtered.length === 0) return [];

      // Bestelldaten laden
      const orderIds = filtered.map((f: any) => f.orderId);
      const orderList = await db
        .select()
        .from(orders)
        .where(inArray(orders.orderId, orderIds));
      const orderMap = new Map(orderList.map((o: any) => [o.orderId, o]));

      return filtered.map((f: any) => {
        const order = orderMap.get(f.orderId) || {};
        const isOverdue = f.status === "pending" && new Date(f.dueAt) < now;
        return {
          id: f.id,
          orderId: f.orderId,
          status: f.status,
          dueAt: f.dueAt,
          completedAt: f.completedAt,
          skippedAt: f.skippedAt,
          isOverdue,
          // Bestelldaten
          orderDate: order.orderDate,
          total: order.total ? parseFloat(order.total) : 0,
          // Kundendaten (aus Bestellung)
          customerName: `${order.firstName || ""} ${order.lastName || ""}`.trim(),
          customerEmail: order.email || "",
          customerPhone: order.phone || "",
          customerId: order.customerId,
          discountCode: order.discountCode,
          partnerCode: order.partnerCode,
          trackingNumber: order.trackingNumber,
          shippedAt: order.shippedAt,
        };
      });
    }),

  /**
   * Dashboard-Statistiken für das Widget
   */
  dashboardStats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const allPending = await db
      .select({ id: salesFollowups.id, dueAt: salesFollowups.dueAt })
      .from(salesFollowups)
      .where(eq(salesFollowups.status, "pending"));

    const dueTodayCount = allPending.filter((f: any) => {
      const due = new Date(f.dueAt);
      return due >= todayStart && due < todayEnd;
    }).length;

    const overdueCount = allPending.filter((f: any) => {
      return new Date(f.dueAt) < todayStart;
    }).length;

    const totalPending = allPending.length;

    return { dueTodayCount, overdueCount, totalPending };
  }),

  /**
   * Vollständige Detailansicht eines Follow-ups inkl. Bestellhistorie
   */
  getFollowUpDetail: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Follow-up laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.id))
        .limit(1);

      if (!followUp) throw new Error("Follow-up nicht gefunden");

      // Ursprungsbestellung laden
      const [originOrder] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);

      if (!originOrder) throw new Error("Ursprungsbestellung nicht gefunden");

      // Artikel der Ursprungsbestellung
      const originItems = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, followUp.orderId));

      // Vollständige Bestellhistorie des Kunden
      const allCustomerOrders = await getCustomerOrderHistory(db, originOrder);

      // Für jede Bestellung die Items laden
      const allOrderIds = allCustomerOrders.map((o: any) => o.orderId);
      const allItems = allOrderIds.length > 0
        ? await db.select().from(orderItems).where(inArray(orderItems.orderId, allOrderIds))
        : [];

      // Items nach orderId gruppieren
      const itemsByOrder = new Map<string, any[]>();
      for (const item of allItems) {
        if (!itemsByOrder.has(item.orderId)) itemsByOrder.set(item.orderId, []);
        itemsByOrder.get(item.orderId)!.push(item);
      }

      // Statistiken
      const nonCancelledOrders = allCustomerOrders.filter((o: any) => o.status !== "storniert");
      const totalSpent = nonCancelledOrders.reduce(
        (sum: number, o: any) => sum + parseFloat(o.total || "0"),
        0
      );

      // Alle gekauften Artikel-IDs sammeln
      const boughtArticleIds = new Set<number>();
      for (const item of allItems) {
        if (item.articleId) boughtArticleIds.add(item.articleId);
      }

      // Ausgewählte Produkte für dieses Follow-up
      const selectedProducts = await db
        .select({
          id: salesFollowupProducts.id,
          articleId: salesFollowupProducts.articleId,
          name: articles.name,
          sellingPrice: articles.sellingPrice,
          shopProductId: articles.shopProductId,
          category: articles.category,
          stock: articles.stock,
        })
        .from(salesFollowupProducts)
        .leftJoin(articles, eq(salesFollowupProducts.articleId, articles.id))
        .where(eq(salesFollowupProducts.followupId, input.id));

      return {
        followUp,
        originOrder: {
          ...originOrder,
          items: originItems,
        },
        customerHistory: allCustomerOrders.map((o: any) => ({
          ...o,
          items: itemsByOrder.get(o.orderId) || [],
        })),
        stats: {
          totalOrders: allCustomerOrders.length,
          totalSpent,
          boughtArticleIds: Array.from(boughtArticleIds),
        },
        selectedProducts,
      };
    }),

  /**
   * Produkte für ein Follow-up auswählen (ersetzt bestehende Auswahl)
   */
  selectProducts: adminProcedure
    .input(z.object({
      followupId: z.number(),
      articleIds: z.array(z.number()),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Alte Auswahl löschen
      await db
        .delete(salesFollowupProducts)
        .where(eq(salesFollowupProducts.followupId, input.followupId));

      // Neue Auswahl speichern
      if (input.articleIds.length > 0) {
        await db.insert(salesFollowupProducts).values(
          input.articleIds.map((articleId) => ({
            followupId: input.followupId,
            articleId,
          }))
        );
      }

      return { ok: true };
    }),

  /**
   * Nachrichten generieren (WhatsApp + E-Mail) und im Follow-up speichern
   */
  generateMessages: adminProcedure
    .input(z.object({ followupId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await ensureOnceAgainCode(db);

      // Follow-up laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.followupId))
        .limit(1);
      if (!followUp) throw new Error("Follow-up nicht gefunden");

      // Ursprungsbestellung laden
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      // Ausgewählte Produkte laden
      const selectedProducts = await db
        .select({
          id: articles.id,
          name: articles.name,
          sellingPrice: articles.sellingPrice,
          shopProductId: articles.shopProductId,
          category: articles.category,
        })
        .from(salesFollowupProducts)
        .leftJoin(articles, eq(salesFollowupProducts.articleId, articles.id))
        .where(eq(salesFollowupProducts.followupId, input.followupId));

      if (selectedProducts.length === 0) {
        throw new Error("Keine Produkte ausgewählt. Bitte zuerst Produkte auswählen.");
      }

      // Nachrichten generieren
      const whatsappMessage = generateWhatsAppMessage(order, selectedProducts, FOLLOWUP_CODE);
      const { subject, body } = generateEmailContent(order, selectedProducts, FOLLOWUP_CODE);

      // Im Follow-up speichern
      await db
        .update(salesFollowups)
        .set({
          whatsappMessage,
          emailSubject: subject,
          emailBody: body,
          updatedAt: new Date(),
        })
        .where(eq(salesFollowups.id, input.followupId));

      return { whatsappMessage, emailSubject: subject, emailBody: body };
    }),

  /**
   * Follow-up als erledigt markieren
   */
  markDone: adminProcedure
    .input(z.object({
      followupId: z.number(),
      completedBy: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db
        .update(salesFollowups)
        .set({
          status: "done",
          completedAt: new Date(),
          completedBy: input.completedBy || ctx.user?.username || "admin",
          updatedAt: new Date(),
        })
        .where(eq(salesFollowups.id, input.followupId));

      return { ok: true };
    }),

  /**
   * Follow-up überspringen
   */
  markSkipped: adminProcedure
    .input(z.object({ followupId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db
        .update(salesFollowups)
        .set({
          status: "skipped",
          skippedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(salesFollowups.id, input.followupId));

      return { ok: true };
    }),

  /**
   * Follow-up E-Mail via Resend senden
   */
  sendFollowUpEmail: adminProcedure
    .input(z.object({ followupId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      if (!ENV.resendApiKey) throw new Error("Resend API Key nicht konfiguriert");

      // Follow-up laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.followupId))
        .limit(1);
      if (!followUp) throw new Error("Follow-up nicht gefunden");

      if (!followUp.emailBody || !followUp.emailSubject) {
        throw new Error("Nachrichten noch nicht generiert. Bitte zuerst Nachrichten generieren.");
      }

      // Bestellung laden für E-Mail-Adresse
      const [order] = await db
        .select({ email: orders.email, firstName: orders.firstName, lastName: orders.lastName })
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      if (!order.email) throw new Error("Kunde hat keine E-Mail-Adresse");

      // E-Mail senden via Resend
      const response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${ENV.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "369 Research <noreply@369research.eu>",
          to: [order.email],
          subject: followUp.emailSubject,
          html: followUp.emailBody,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`E-Mail-Versand fehlgeschlagen: ${response.status} – ${errorBody}`);
      }

      // Versandstatus speichern
      await db
        .update(salesFollowups)
        .set({
          emailSentAt: new Date(),
          emailSentTo: order.email,
          updatedAt: new Date(),
        })
        .where(eq(salesFollowups.id, input.followupId));

      console.log(`[FollowUp] E-Mail gesendet an ${order.email} für Follow-up ${input.followupId}`);
      return { ok: true, sentTo: order.email };
    }),

  /**
   * Verfügbare Produkte für Produktauswahl laden
   * (aktiv + shopVisible, mit "bereits gekauft" Kennzeichnung)
   */
  getAvailableProducts: adminProcedure
    .input(z.object({
      followupId: z.number(),
      search: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Follow-up + Ursprungsbestellung laden
      const [followUp] = await db
        .select()
        .from(salesFollowups)
        .where(eq(salesFollowups.id, input.followupId))
        .limit(1);
      if (!followUp) throw new Error("Follow-up nicht gefunden");

      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, followUp.orderId))
        .limit(1);

      // Alle Bestellungen des Kunden für "bereits gekauft" Kennzeichnung
      const allCustomerOrders = order ? await getCustomerOrderHistory(db, order) : [];
      const allOrderIds = allCustomerOrders.map((o: any) => o.orderId);

      const allItems = allOrderIds.length > 0
        ? await db.select({ articleId: orderItems.articleId }).from(orderItems)
            .where(inArray(orderItems.orderId, allOrderIds))
        : [];

      const boughtArticleIds = new Set(
        allItems.map((i: any) => i.articleId).filter(Boolean)
      );

      // Aktive + shopVisible Artikel laden
      let allArticles = await db
        .select({
          id: articles.id,
          name: articles.name,
          sellingPrice: articles.sellingPrice,
          shopProductId: articles.shopProductId,
          category: articles.category,
          stock: articles.stock,
        })
        .from(articles)
        .where(
          and(
            eq(articles.isActive, 1),
            eq(articles.shopVisible, 1)
          )
        )
        .orderBy(articles.name);

      // Suche filtern
      if (input.search) {
        const q = input.search.toLowerCase();
        allArticles = allArticles.filter((a: any) =>
          a.name.toLowerCase().includes(q) ||
          (a.category || "").toLowerCase().includes(q)
        );
      }

      // Bereits ausgewählte Produkte
      const selectedProducts = await db
        .select({ articleId: salesFollowupProducts.articleId })
        .from(salesFollowupProducts)
        .where(eq(salesFollowupProducts.followupId, input.followupId));
      const selectedIds = new Set(selectedProducts.map((p: any) => p.articleId));

      return allArticles.map((a: any) => ({
        ...a,
        sellingPrice: a.sellingPrice ? parseFloat(a.sellingPrice) : 0,
        alreadyBought: boughtArticleIds.has(a.id),
        isSelected: selectedIds.has(a.id),
        shopLink: a.shopProductId ? `${SHOP_BASE_URL}/product/${a.shopProductId}` : null,
      }));
    }),
});
