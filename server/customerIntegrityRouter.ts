import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { customers, duplicateCheckRuns, duplicateFindings, orderItems, orders, shopSettings } from "../drizzle/schema.js";
import { runDuplicateCheck } from "./customerIntegrityService.js";

const PAID = new Set(["bezahlt", "gepackt", "versendet", "zugestellt"]);

function customerPreview(customer: typeof customers.$inferSelect | undefined) {
  if (!customer) return null;
  const address = [customer.street, customer.houseNumber].filter(Boolean).join(" ");
  const cityLine = [customer.zip, customer.city].filter(Boolean).join(" ");
  return {
    id: customer.id,
    customerNumber: customer.customerNumber,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    address: [address, cityLine, customer.country].filter(Boolean).join(", "),
  };
}

function orderPreview(order: typeof orders.$inferSelect | undefined) {
  if (!order) return null;
  return {
    orderId: order.orderId,
    name: `${order.firstName} ${order.lastName}`.trim(),
    email: order.email,
    phone: order.phone,
    total: Number(order.total || 0),
    status: order.status,
    orderDate: order.orderDate,
  };
}

/** Human-readable, review-only duplicate queue. It never changes customer, order or stock data. */
export const customerIntegrityRouter = router({
  customerOverview: adminProcedure.input(z.object({ customerId: z.number().optional(), email: z.string().email().optional() })).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    const records = input.customerId
      ? await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1)
      : input.email ? await db.select().from(customers).where(eq(customers.email, input.email.trim().toLowerCase())).limit(1) : [];
    const [customer] = records;
    if (!customer) return null;
    const linked = (await db.select().from(orders).orderBy(desc(orders.orderDate))).filter((order) => order.customerId === customer.id);
    const countable = linked.filter((order) => PAID.has(order.status));
    // Nur die in der UI gezeigten jüngsten Bestellungen mit Positionen anreichern.
    // Umsatz und Anzahl bleiben trotzdem über die gesamte Historie korrekt berechnet.
    const historyOrders = linked.slice(0, 10);
    const historyOrderIds = historyOrders.map((order) => order.orderId);
    const historyItems = historyOrderIds.length > 0
      ? await db.select().from(orderItems).where(inArray(orderItems.orderId, historyOrderIds))
      : [];
    const itemsByOrderId = new Map<string, typeof historyItems>();
    for (const item of historyItems) {
      const existing = itemsByOrderId.get(item.orderId) || [];
      existing.push(item);
      itemsByOrderId.set(item.orderId, existing);
    }
    return {
      customerId: customer.id,
      totalOrders: countable.length,
      totalSpent: countable.reduce((sum, order) => sum + Number(order.total || 0), 0),
      lastOrderAt: linked[0]?.orderDate || null,
      orders: historyOrders.map((order) => ({
        orderId: order.orderId,
        orderDate: order.orderDate,
        status: order.status,
        total: Number(order.total || 0),
        internalNote: order.internalNote || null,
        items: (itemsByOrderId.get(order.orderId) || []).map((item) => ({
          name: item.name,
          dosage: item.dosage,
          variant: item.variant,
          quantity: item.quantity,
          price: Number(item.price || 0),
          isNasalSpray: item.isNasalSpray,
          isNasalDiySet: item.isNasalDiySet,
          isPlugPlay: item.isPlugPlay,
        })),
      })),
    };
  }),

  findings: adminProcedure.input(z.object({
    status: z.enum(["open", "reviewed", "merged", "ignored", "archived"]).optional(),
    entityType: z.enum(["customer", "order"]).optional(),
    limit: z.number().int().min(1).max(50).optional().default(12),
  }).optional()).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    let records = await db.select().from(duplicateFindings).orderBy(desc(duplicateFindings.createdAt));
    if (input?.status) records = records.filter((record) => record.status === input.status);
    if (input?.entityType) records = records.filter((record) => record.entityType === input.entityType);
    records = records.slice(0, input?.limit || 12);

    const allCustomers = await db.select().from(customers);
    const allOrders = await db.select().from(orders);
    const customersById = new Map(allCustomers.map((customer) => [String(customer.id), customer]));
    const ordersById = new Map(allOrders.map((order) => [order.orderId, order]));

    return records.map((record) => {
      const primary = record.entityType === "customer"
        ? customerPreview(customersById.get(record.primaryRecordId))
        : orderPreview(ordersById.get(record.primaryRecordId));
      const candidate = record.entityType === "customer"
        ? customerPreview(customersById.get(record.candidateRecordId))
        : orderPreview(ordersById.get(record.candidateRecordId));
      return {
        ...record,
        reasons: JSON.parse(record.reasons) as string[],
        primary,
        candidate,
      };
    });
  }),

  runs: adminProcedure.query(async () => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    return db.select().from(duplicateCheckRuns).orderBy(desc(duplicateCheckRuns.startedAt));
  }),

  // Diagnostic full scan only. It is not scheduled and is not used in the daily WaWi workflow.
  runNow: adminProcedure.mutation(async ({ ctx }) => runDuplicateCheck("manual", ctx.user?.name || ctx.user?.username || "admin")),

  resolveFinding: adminProcedure.input(z.object({ id: z.number(), status: z.enum(["reviewed", "merged", "ignored"]), note: z.string().max(2000).optional() })).mutation(async ({ input, ctx }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    await db.update(duplicateFindings).set({ status: input.status, resolutionNote: input.note || null, resolvedBy: ctx.user?.name || ctx.user?.username || "admin", resolvedAt: new Date() }).where(eq(duplicateFindings.id, input.id));
    return { success: true };
  }),

  config: adminProcedure.query(async () => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    const rows = await db.select().from(shopSettings);
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return { mode: "event_driven" as const, lastRun: settings.customer_integrity_last_run || null };
  }),
});
