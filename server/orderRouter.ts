/**
 * Order Router – tRPC routes for order management (WaWi)
 * Public: createOrder (from checkout)
 * Protected (admin): list, updateStatus, matchPayments, etc.
 */

import { z } from "zod";
import { eq, desc, inArray } from "drizzle-orm";
import { router, publicProcedure, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { orders, orderItems } from "../drizzle/schema.js";
import { getIncomingPayments, matchPaymentToOrder } from "./bunqService.js";
import { sendOrderConfirmationEmail, sendShippingNotificationEmail } from "./emailService.js";
import { partners, partnerTransactions } from "../drizzle/schema.js";

// Zod schemas
const createOrderSchema = z.object({
  orderId: z.string(),
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
  paymentMethod: z.enum(["bunq", "creditCard", "wise"]),
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

      // ── Partner logic: validate code, calculate discount & commission ──
      let partnerCode = input.partnerCode || null;
      let partnerNumber = input.partnerNumber || null;
      let partnerDiscountAmount = input.partnerDiscount || 0;
      let partnerCommissionAmount = 0;
      let creditUsed = input.creditUsed || 0;

      if (partnerCode) {
        const { and: andOp } = await import("drizzle-orm");
        const [partner] = await db.select().from(partners)
          .where(andOp(eq(partners.code, partnerCode.toUpperCase()), eq(partners.isActive, 1)))
          .limit(1);

        if (partner) {
          // Calculate commission on product subtotal after discount (not on shipping)
          const productSubtotalAfterDiscount = input.subtotal - partnerDiscountAmount;
          const commissionRate = parseFloat(partner.commissionPercent) / 100;
          partnerCommissionAmount = Math.round(productSubtotalAfterDiscount * commissionRate * 100) / 100;

          // Book commission: update partner balance
          const currentBalance = parseFloat(partner.creditBalance);
          const newBalance = currentBalance + partnerCommissionAmount;

          await db.update(partners).set({
            creditBalance: newBalance.toFixed(2),
            updatedAt: new Date(),
          }).where(eq(partners.id, partner.id));

          // Record provision transaction
          await db.insert(partnerTransactions).values({
            partnerId: partner.id,
            type: "provision",
            amount: partnerCommissionAmount.toFixed(2),
            balanceAfter: newBalance.toFixed(2),
            orderId: input.orderId,
            customerName: `${input.customer.firstName} ${input.customer.lastName}`,
            description: `Provision f\u00fcr Bestellung ${input.orderId} (${input.customer.firstName} ${input.customer.lastName})`,
          });

          console.log(`[Orders] Partner commission: ${partnerCommissionAmount.toFixed(2)} EUR for ${partner.name}`);
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
              orderId: input.orderId,
              description: `Guthaben eingel\u00f6st f\u00fcr Bestellung ${input.orderId}`,
            });

            creditUsed = actualCreditUsed;
            console.log(`[Orders] Partner credit redeemed: ${actualCreditUsed.toFixed(2)} EUR by ${partner.name}`);
          }
        }
      }

      // Insert order
      await db.insert(orders).values({
        orderId: input.orderId,
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
          orderId: input.orderId,
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
      console.log(`[Orders] New order: ${input.orderId} – ${input.total.toFixed(2)} EUR – ${input.customer.firstName} ${input.customer.lastName} – ${itemList}`);

      // Send order confirmation email to customer
      try {
        await sendOrderConfirmationEmail({
          orderId: input.orderId,
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

      return { success: true, orderId: input.orderId };
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

  // ADMIN: Bunq payment matching
  matchBunqPayments: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Get all open orders
    const openOrders = await db.select().from(orders).where(eq(orders.status, "offen"));
    if (openOrders.length === 0) {
      return { matched: 0, message: "Keine offenen Bestellungen vorhanden." };
    }

    const orderIds = openOrders.map(o => o.orderId);

    // Get incoming payments from Bunq
    const payments = await getIncomingPayments(200);

    let matchedCount = 0;
    const matchedDetails: { orderId: string; paymentId: number; amount: string; sender: string }[] = [];

    for (const payment of payments) {
      const matchedOrderId = matchPaymentToOrder(payment, orderIds);
      if (matchedOrderId) {
        // Check if amount matches
        const order = openOrders.find(o => o.orderId === matchedOrderId);
        if (!order) continue;

        const paymentAmount = parseFloat(payment.amount.value);
        const orderTotal = parseFloat(order.total);

        // Allow small tolerance (0.01 EUR)
        if (Math.abs(paymentAmount - orderTotal) <= 0.01) {
          // Update order status to "bezahlt"
          await db.update(orders).set({
            status: "bezahlt",
            paidAt: new Date(),
            bunqPaymentId: String(payment.id),
            bunqMatchedAt: new Date(),
          }).where(eq(orders.orderId, matchedOrderId));

          matchedCount++;
          matchedDetails.push({
            orderId: matchedOrderId,
            paymentId: payment.id,
            amount: payment.amount.value,
            sender: payment.counterpartyAlias.name,
          });
        }
      }
    }

    return {
      matched: matchedCount,
      details: matchedDetails,
      totalPaymentsChecked: payments.length,
      openOrdersChecked: openOrders.length,
      message: matchedCount > 0
        ? `${matchedCount} Bestellung(en) als bezahlt markiert!`
        : "Keine passenden Zahlungen gefunden.",
    };
  }),

  // ADMIN: Get recent Bunq payments (for manual review)
  bunqPayments: adminProcedure
    .input(z.object({ count: z.number().optional() }).optional())
    .query(async ({ input }) => {
      const payments = await getIncomingPayments(input?.count || 50);
      return payments;
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
