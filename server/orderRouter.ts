/**
 * Order Router – tRPC routes for order management (WaWi)
 * Public: createOrder (from checkout)
 * Protected (admin): list, updateStatus, matchPayments, etc.
 */

import { z } from "zod";
import { eq, desc, inArray } from "drizzle-orm";
import { router, publicProcedure, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { orders, orderItems, articles, stockHistory } from "../drizzle/schema.js";
import { getIncomingPayments, matchPaymentToOrder, intelligentMatch, type MatchResult } from "./bunqService.js";
import { sendOrderConfirmationEmail, sendShippingNotificationEmail } from "./emailService.js";
import { partners, partnerTransactions } from "../drizzle/schema.js";

// Zod schemas
const createOrderSchema = z.object({
  orderId: z.string().optional(), // now generated server-side via DB sequence
  items: z.array(z.object({
    name: z.string(),
    dosage: z.string().optional(),
    variant: z.string().optional(),
    price: z.number(),
    quantity: z.number(),
    type: z.string(),
  })),
  customer: z.object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string().email(),
    phone: z.string(),
    street: z.string(),
    houseNumber: z.string(),
    zip: z.string(),
    city: z.string(),
    country: z.string(),
    company: z.string().optional(),
  }),
  subtotal: z.number(),
  discount: z.number(),
  discountCode: z.string().nullable(),
  shipping: z.number(),
  shippingCountry: z.string(),
  total: z.number(),
  paymentMethod: z.enum(["bunq", "creditCard", "wise", "SEPA", "Bar", "Kreditkarte", "PayPal", "Crypto", "Guthaben", "Sonstige"]),
  date: z.string(),
  // Partner fields
  partnerCode: z.string().nullable().optional(),
  partnerNumber: z.string().nullable().optional(),
  partnerDiscount: z.number().optional(),
  creditUsed: z.number().optional(),
});

const updateStatusSchema = z.object({
  orderId: z.string(),
  status: z.enum(["offen", "bezahlt", "gepackt", "versendet", "zugestellt", "storniert"]),
  trackingNumber: z.string().optional(),
  trackingCarrier: z.string().optional(),
  internalNote: z.string().optional(),
});

export const orderRouter = router({
  // PUBLIC: Create order from checkout (no auth required)
  create: publicProcedure
    .input(createOrderSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // ── Generate sequential order ID from DB sequence ──
      let orderId = input.orderId || `369-${Date.now()}`;
      try {
        const { sql } = await import('drizzle-orm');
        const seqResult = await db.execute(sql`SELECT next_order_id() as order_id`);
        const rows = seqResult as any;
        if (rows && rows.length > 0 && rows[0].order_id) {
          orderId = rows[0].order_id;
        } else if (rows?.rows && rows.rows.length > 0) {
          orderId = rows.rows[0].order_id;
        }
      } catch (err) {
        console.warn('[Orders] Failed to generate sequential order ID, using fallback:', err);
      }

      // ── Partner logic: validate code, calculate discount & commission ──
      let partnerCode = input.partnerCode || null;
      let partnerNumber = input.partnerNumber || null;
      let partnerDiscountAmount = input.partnerDiscount || 0;
      let partnerCommissionAmount = 0;
      let creditUsed = input.creditUsed || 0;

      // Helper: Book commission for a partner
      const bookPartnerCommission = async (partner: any, reason: string) => {
        const productSubtotalAfterDiscount = input.subtotal - partnerDiscountAmount;
        const commissionRate = parseFloat(partner.commissionPercent) / 100;
        partnerCommissionAmount = Math.round(productSubtotalAfterDiscount * commissionRate * 100) / 100;

        if (partnerCommissionAmount <= 0) return;

        const currentBalance = parseFloat(partner.creditBalance);
        const newBalance = currentBalance + partnerCommissionAmount;

        await db.update(partners).set({
          creditBalance: newBalance.toFixed(2),
          updatedAt: new Date(),
        }).where(eq(partners.id, partner.id));

        await db.insert(partnerTransactions).values({
          partnerId: partner.id,
          type: "provision",
          amount: partnerCommissionAmount.toFixed(2),
          balanceAfter: newBalance.toFixed(2),
          orderId: orderId,
          customerName: `${input.customer.firstName} ${input.customer.lastName}`,
          description: `Provision für Bestellung ${orderId} (${input.customer.firstName} ${input.customer.lastName}) [${reason}]`,
        });

        // Also set the partnerCode on the order for tracking
        if (!partnerCode) partnerCode = partner.code;

        console.log(`[Orders] Partner commission: ${partnerCommissionAmount.toFixed(2)} EUR for ${partner.name} (${reason})`);
      };

      // Case 1: Partner CODE was provided (customer or partner entered the code)
      if (partnerCode) {
        const { and: andOp } = await import("drizzle-orm");
        const [partner] = await db.select().from(partners)
          .where(andOp(eq(partners.code, partnerCode.toUpperCase()), eq(partners.isActive, 1)))
          .limit(1);

        if (partner) {
          await bookPartnerCommission(partner, "Code");
        }
      }

      // Case 2: Partner NUMBER was provided but no code – partner ordering for themselves
      // Also book commission for the partner (they get both discount + commission)
      if (partnerNumber && !partnerCode) {
        const { and: andOp } = await import("drizzle-orm");
        const [partner] = await db.select().from(partners)
          .where(andOp(eq(partners.partnerNumber, partnerNumber), eq(partners.isActive, 1)))
          .limit(1);

        if (partner) {
          await bookPartnerCommission(partner, "Eigenbestellung");
        }
      }

      // ── Partner credit redemption ──
      if (partnerNumber && creditUsed > 0) {
        const { and: andOp } = await import("drizzle-orm");
        const [partner] = await db.select().from(partners)
          .where(andOp(eq(partners.partnerNumber, partnerNumber), eq(partners.isActive, 1)))
          .limit(1);

        if (partner) {
          const currentBalance = parseFloat(partner.creditBalance);
          const actualCreditUsed = Math.min(creditUsed, currentBalance);

          if (actualCreditUsed > 0) {
            const newBalance = currentBalance - actualCreditUsed;

            await db.update(partners).set({
              creditBalance: newBalance.toFixed(2),
              updatedAt: new Date(),
            }).where(eq(partners.id, partner.id));

            // Record redemption transaction
            await db.insert(partnerTransactions).values({
              partnerId: partner.id,
              type: "einloesung",
              amount: (-actualCreditUsed).toFixed(2),
              balanceAfter: newBalance.toFixed(2),
                  orderId: orderId,
              description: `Guthaben eingelöst für Bestellung ${orderId}`,
            });

            creditUsed = actualCreditUsed;
            console.log(`[Orders] Partner credit redeemed: ${actualCreditUsed.toFixed(2)} EUR by ${partner.name}`);
          }
        }
      }

      // Insert order
      await db.insert(orders).values({
        orderId: orderId,
        firstName: input.customer.firstName,
        lastName: input.customer.lastName,
        email: input.customer.email,
        phone: input.customer.phone,
        street: input.customer.street,
        houseNumber: input.customer.houseNumber,
        zip: input.customer.zip,
        city: input.customer.city,
        country: input.customer.country,
        company: input.customer.company || null,
        subtotal: input.subtotal.toFixed(2),
        discount: input.discount.toFixed(2),
        discountCode: input.discountCode,
        shipping: input.shipping.toFixed(2),
        shippingCountry: input.shippingCountry,
        total: input.total.toFixed(2),
        paymentMethod: input.paymentMethod,
        status: "offen",
        orderDate: new Date(input.date),
        partnerCode: partnerCode ? partnerCode.toUpperCase() : null,
        partnerNumber: partnerNumber || null,
        partnerDiscount: partnerDiscountAmount.toFixed(2),
        partnerCommission: partnerCommissionAmount.toFixed(2),
        creditUsed: creditUsed.toFixed(2),
      });

      // Insert order items
      for (const item of input.items) {
        await db.insert(orderItems).values({
          orderId: orderId,
          name: item.name,
          dosage: item.dosage || null,
          variant: item.variant || null,
          type: item.type,
          price: item.price.toFixed(2),
          quantity: item.quantity,
        });
      }

      // Log new order
      const itemList = input.items.map(i => `${i.quantity}x ${i.name}${i.dosage ? ` (${i.dosage})` : ""}`).join(", ");
      console.log(`[Orders] New order: ${orderId} – ${input.total.toFixed(2)} EUR – ${input.customer.firstName} ${input.customer.lastName} – ${itemList}`);

      // Send order confirmation email to customer
      try {
        await sendOrderConfirmationEmail({
          orderId: orderId,
          customer: input.customer,
          items: input.items.map(i => ({ ...i, dosage: i.dosage || null, variant: i.variant || null })),
          subtotal: input.subtotal,
          discount: input.discount,
          discountCode: input.discountCode,
          shipping: input.shipping,
          total: input.total,
          paymentMethod: input.paymentMethod,
        });
      } catch (err) {
        console.warn("[Orders] Failed to send confirmation email:", err);
      }

      return { success: true, orderId: orderId };
    }),

  // ADMIN: List all orders with items
  list: adminProcedure
    .input(z.object({
      status: z.enum(["alle", "offen", "bezahlt", "gepackt", "versendet", "zugestellt", "storniert"]).optional(),
      search: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let query = db.select().from(orders).orderBy(desc(orders.orderDate));

      const allOrders = await query;

      // Filter by status
      let filtered = allOrders;
      if (input?.status && input.status !== "alle") {
        filtered = filtered.filter(o => o.status === input.status);
      }

      // Search
      if (input?.search) {
        const s = input.search.toLowerCase();
        filtered = filtered.filter(o =>
          o.orderId.toLowerCase().includes(s) ||
          o.firstName.toLowerCase().includes(s) ||
          o.lastName.toLowerCase().includes(s) ||
          o.email.toLowerCase().includes(s)
        );
      }

      // Get items for each order
      const orderIds = filtered.map(o => o.orderId);
      let items: any[] = [];
      if (orderIds.length > 0) {
        items = await db.select().from(orderItems).where(
          inArray(orderItems.orderId, orderIds)
        );
      }

      // Combine
      const result = filtered.map(o => ({
        ...o,
        subtotal: parseFloat(o.subtotal),
        discount: parseFloat(o.discount),
        shipping: parseFloat(o.shipping),
        total: parseFloat(o.total),
        items: items
          .filter(i => i.orderId === o.orderId)
          .map(i => ({
            ...i,
            price: parseFloat(i.price),
          })),
      }));

      return result;
    }),

  // ADMIN: Get single order with items
  get: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Order not found");

      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, input.orderId));

      return {
        ...order,
        subtotal: parseFloat(order.subtotal),
        discount: parseFloat(order.discount),
        shipping: parseFloat(order.shipping),
        total: parseFloat(order.total),
        items: items.map(i => ({ ...i, price: parseFloat(i.price) })),
      };
    }),

  // ADMIN: Update order status
  updateStatus: adminProcedure
    .input(updateStatusSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const updateData: Record<string, any> = {
        status: input.status,
      };

      // Set timestamps based on status
      const now = new Date();
      if (input.status === "bezahlt") updateData.paidAt = now;
      if (input.status === "gepackt") updateData.packedAt = now;
      if (input.status === "versendet") {
        updateData.shippedAt = now;
        if (input.trackingNumber) updateData.trackingNumber = input.trackingNumber;
        if (input.trackingCarrier) updateData.trackingCarrier = input.trackingCarrier;
      }
      if (input.status === "zugestellt") updateData.deliveredAt = now;
      if (input.status === "storniert") updateData.cancelledAt = now;
      if (input.internalNote !== undefined) updateData.internalNote = input.internalNote;

      await db.update(orders).set(updateData).where(eq(orders.orderId, input.orderId));

      // Send shipping notification email when status changes to "versendet"
      if (input.status === "versendet") {
        try {
          const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
          if (order) {
            await sendShippingNotificationEmail({
              orderId: input.orderId,
              customerEmail: order.email,
              customerName: order.firstName,
              trackingNumber: input.trackingNumber,
              trackingCarrier: input.trackingCarrier,
            });
          }
        } catch (err) {
          console.warn("[Orders] Failed to send shipping notification:", err);
        }
      }

      return { success: true };
    }),

  // ADMIN: Get order statistics
  stats: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const allOrders = await db.select().from(orders);

    const stats = {
      total: allOrders.length,
      offen: allOrders.filter(o => o.status === "offen").length,
      bezahlt: allOrders.filter(o => o.status === "bezahlt").length,
      gepackt: allOrders.filter(o => o.status === "gepackt").length,
      versendet: allOrders.filter(o => o.status === "versendet").length,
      zugestellt: allOrders.filter(o => o.status === "zugestellt").length,
      storniert: allOrders.filter(o => o.status === "storniert").length,
      umsatzBezahlt: allOrders
        .filter(o => ["bezahlt", "gepackt", "versendet", "zugestellt"].includes(o.status))
        .reduce((sum, o) => sum + parseFloat(o.total), 0),
      umsatzOffen: allOrders
        .filter(o => o.status === "offen")
        .reduce((sum, o) => sum + parseFloat(o.total), 0),
    };

    return stats;
  }),

  // ADMIN: Bunq payment matching (intelligent)
  matchBunqPayments: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Get today's date range (start of day to now)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get ALL recent orders (not just open ones):
    // - Open orders (need matching)
    // - Today's paid orders (for display)
    // - Orders without bunq match (bunqPaymentId is null)
    const allOrders = await db.select().from(orders).orderBy(desc(orders.orderDate));
    
    // Filter: open orders + today's bezahlt orders + any order without bunq match
    const relevantOrders = allOrders.filter(o => {
      const isOpen = o.status === "offen";
      const isTodayPaid = o.status === "bezahlt" && o.orderDate && new Date(o.orderDate) >= today;
      const isUnmatched = !o.bunqPaymentId && ["offen", "bezahlt"].includes(o.status);
      return isOpen || isTodayPaid || isUnmatched;
    });

    if (relevantOrders.length === 0) {
      return { 
        matched: 0, 
        results: [],
        totalPaymentsChecked: 0,
        message: "Keine relevanten Bestellungen vorhanden." 
      };
    }

    // Get incoming payments from Bunq
    const payments = await getIncomingPayments(200);

    let autoMatchedCount = 0;
    const results: Array<{
      orderId: string;
      customerName: string;
      orderTotal: number;
      orderStatus: string;
      orderDate: string;
      matchType: string;
      confidence: string;
      amountMatch: boolean;
      nameMatch: boolean;
      orderNumberMatch: boolean;
      paymentId: number | null;
      paymentAmount: string | null;
      paymentSender: string | null;
      paymentDescription: string | null;
      paymentDate: string | null;
      autoMatched: boolean;
      alreadyPaid: boolean;
    }> = [];

    // Track which payments have been used for matching
    const usedPaymentIds = new Set<number>();

    for (const order of relevantOrders) {
      const alreadyPaid = order.status === "bezahlt";
      const alreadyBunqMatched = !!order.bunqPaymentId;

      // Run intelligent matching
      const match = intelligentMatch(
        {
          orderId: order.orderId,
          firstName: order.firstName,
          lastName: order.lastName,
          total: order.total,
        },
        // Exclude already-used payments
        payments.filter(p => !usedPaymentIds.has(p.id))
      );

      let autoMatched = false;

      // Auto-match only for open orders with high confidence + amount match
      if (
        order.status === "offen" &&
        match.confidence === "high" &&
        match.amountMatch &&
        match.matchedPayment &&
        !usedPaymentIds.has(match.matchedPayment.id)
      ) {
        // Auto-mark as paid
        await db.update(orders).set({
          status: "bezahlt",
          paidAt: new Date(),
          bunqPaymentId: String(match.matchedPayment.id),
          bunqMatchedAt: new Date(),
        }).where(eq(orders.orderId, order.orderId));

        usedPaymentIds.add(match.matchedPayment.id);
        autoMatchedCount++;
        autoMatched = true;
      }

      // If already bunq-matched, find the original payment for display
      let displayPayment = match.matchedPayment;
      if (alreadyBunqMatched && order.bunqPaymentId) {
        const existingPayment = payments.find(p => String(p.id) === order.bunqPaymentId);
        if (existingPayment) displayPayment = existingPayment;
      }

      results.push({
        orderId: order.orderId,
        customerName: `${order.firstName} ${order.lastName}`,
        orderTotal: parseFloat(order.total),
        orderStatus: autoMatched ? "bezahlt" : order.status,
        orderDate: order.orderDate ? new Date(order.orderDate).toISOString() : "",
        matchType: alreadyBunqMatched ? "alreadyMatched" : match.matchType,
        confidence: alreadyBunqMatched ? "high" : match.confidence,
        amountMatch: match.amountMatch,
        nameMatch: match.nameMatch,
        orderNumberMatch: match.orderNumberMatch,
        paymentId: displayPayment?.id || null,
        paymentAmount: displayPayment?.amount.value || null,
        paymentSender: displayPayment?.counterpartyAlias.name || null,
        paymentDescription: displayPayment?.description || null,
        paymentDate: displayPayment?.created || null,
        autoMatched,
        alreadyPaid: alreadyPaid || alreadyBunqMatched,
      });
    }

    // Collect unmatched payments (not used by any order, not already assigned)
    const allAssignedPaymentIds = new Set<number>();
    // Add IDs from auto-matched
    for (const id of usedPaymentIds) allAssignedPaymentIds.add(id);
    // Add IDs from already-matched orders in DB
    for (const o of allOrders) {
      if (o.bunqPaymentId) allAssignedPaymentIds.add(parseInt(o.bunqPaymentId));
    }
    // Add IDs from results that have a payment match
    for (const r of results) {
      if (r.paymentId) allAssignedPaymentIds.add(r.paymentId);
    }

    // Recent unmatched payments (last 7 days, not assigned to any order)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const unmatchedPayments = payments
      .filter(p => {
        if (allAssignedPaymentIds.has(p.id)) return false;
        const pDate = new Date(p.created);
        return pDate >= sevenDaysAgo;
      })
      .map(p => ({
        id: p.id,
        amount: p.amount.value,
        currency: p.amount.currency,
        sender: p.counterpartyAlias.name || "Unbekannt",
        description: p.description || "",
        date: p.created,
        iban: p.counterpartyAlias.iban || "",
      }));

    return {
      matched: autoMatchedCount,
      results,
      unmatchedPayments,
      totalPaymentsChecked: payments.length,
      message: autoMatchedCount > 0
        ? `${autoMatchedCount} Bestellung(en) automatisch als bezahlt markiert!`
        : "Keine automatischen Matches gefunden. Prüfe die Details unten.",
    };
  }),

  // ADMIN: Manually assign a Bunq payment to an order
  assignBunqPayment: adminProcedure
    .input(z.object({
      orderId: z.string(),
      paymentId: z.number(),
      paymentAmount: z.string(),
      markAsPaid: z.boolean().default(true),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      const updateData: Record<string, any> = {
        bunqPaymentId: String(input.paymentId),
        bunqMatchedAt: new Date(),
      };

      if (input.markAsPaid && order.status === "offen") {
        updateData.status = "bezahlt";
        updateData.paidAt = new Date();
      }

      await db.update(orders).set(updateData).where(eq(orders.orderId, input.orderId));

      console.log(`[Bunq] Manual assignment: Payment ${input.paymentId} (${input.paymentAmount} EUR) -> Order ${input.orderId}`);

      return { success: true, markedAsPaid: input.markAsPaid && order.status === "offen" };
    }),

  // ADMIN: Get recent Bunq payments (for manual review)
  bunqPayments: adminProcedure
    .input(z.object({ count: z.number().optional() }).optional())
    .query(async ({ input }) => {
      const payments = await getIncomingPayments(input?.count || 50);
      return payments;
    }),

  // ADMIN: Migrate payment_method enum to add new values
  migratePaymentEnum: adminProcedure
    .mutation(async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const newValues = ["SEPA", "Bar", "Kreditkarte", "PayPal", "Crypto", "Guthaben", "Sonstige"];
      const results: string[] = [];

      for (const val of newValues) {
        try {
          await db.execute(`ALTER TYPE payment_method ADD VALUE IF NOT EXISTS '${val}'`);
          results.push(`Added: ${val}`);
        } catch (err: any) {
          results.push(`Skipped ${val}: ${err.message}`);
        }
      }

      return { success: true, results };
    }),

  // ADMIN: Delete order with stock restoration
  delete: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Get the order
      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      // Get order items
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, input.orderId));

      // Restore stock for each item that has an articleId
      for (const item of items) {
        if (item.articleId) {
          const [article] = await db.select().from(articles).where(eq(articles.id, item.articleId)).limit(1);
          if (article) {
            const newStock = article.stock + item.quantity;
            await db.update(articles).set({ stock: newStock }).where(eq(articles.id, item.articleId));

            // Log stock restoration
            await db.insert(stockHistory).values({
              articleId: item.articleId,
              changeType: "retoure",
              quantityBefore: article.stock,
              quantityChange: item.quantity,
              quantityAfter: newStock,
              reason: `Bestellung ${input.orderId} gel\u00f6scht`,
              orderId: input.orderId,
              userName: ctx.user?.name || "Admin",
            });
          }
        }
      }

      // Delete order items first
      await db.delete(orderItems).where(eq(orderItems.orderId, input.orderId));

      // Delete the order
      await db.delete(orders).where(eq(orders.orderId, input.orderId));

      console.log(`[Orders] Deleted order ${input.orderId} with stock restoration`);

      return { success: true, restoredItems: items.length };
    }),

  // ADMIN: Add internal note
  addNote: adminProcedure
    .input(z.object({
      orderId: z.string(),
      note: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.update(orders).set({
        internalNote: input.note,
      }).where(eq(orders.orderId, input.orderId));

      return { success: true };
    }),
});
