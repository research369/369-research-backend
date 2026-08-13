import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { customers, duplicateCheckRuns, duplicateFindings, orders, shopSettings } from "../drizzle/schema.js";
import { runDuplicateCheck } from "./customerIntegrityService.js";

const PAID = new Set(["bezahlt", "gepackt", "versendet", "zugestellt"]);

export const customerIntegrityRouter = router({
  customerOverview: adminProcedure.input(z.object({ customerId: z.number().optional(), email: z.string().email().optional() })).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    const records = input.customerId
      ? await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1)
      : input.email ? await db.select().from(customers).where(eq(customers.email, input.email.trim().toLowerCase())).limit(1) : [];
    const [customer] = records;
    if (!customer) return null;
    const linked = (await db.select().from(orders).orderBy(desc(orders.orderDate))).filter(o => o.customerId === customer.id);
    const countable = linked.filter(o => PAID.has(o.status));
    return { customerId: customer.id, totalOrders: countable.length, totalSpent: countable.reduce((sum, o) => sum + Number(o.total || 0), 0), lastOrderAt: linked[0]?.orderDate || null, orders: linked.map(o => ({ orderId: o.orderId, orderDate: o.orderDate, status: o.status, total: Number(o.total || 0) })) };
  }),
  findings: adminProcedure.input(z.object({ status: z.enum(["open", "reviewed", "merged", "ignored"]).optional(), entityType: z.enum(["customer", "order"]).optional() }).optional()).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    let records = await db.select().from(duplicateFindings).orderBy(desc(duplicateFindings.createdAt));
    if (input?.status) records = records.filter(r => r.status === input.status);
    if (input?.entityType) records = records.filter(r => r.entityType === input.entityType);
    return records.map(r => ({ ...r, reasons: JSON.parse(r.reasons) as string[] }));
  }),
  runs: adminProcedure.query(async () => { const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar"); return db.select().from(duplicateCheckRuns).orderBy(desc(duplicateCheckRuns.startedAt)); }),
  runNow: adminProcedure.mutation(async ({ ctx }) => runDuplicateCheck("manual", ctx.user?.name || ctx.user?.username || "admin")),
  resolveFinding: adminProcedure.input(z.object({ id: z.number(), status: z.enum(["reviewed", "merged", "ignored"]), note: z.string().max(2000).optional() })).mutation(async ({ input, ctx }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    await db.update(duplicateFindings).set({ status: input.status, resolutionNote: input.note || null, resolvedBy: ctx.user?.name || ctx.user?.username || "admin", resolvedAt: new Date() }).where(eq(duplicateFindings.id, input.id));
    return { success: true };
  }),
  config: adminProcedure.query(async () => { const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar"); const rows = await db.select().from(shopSettings); const map = Object.fromEntries(rows.map(r => [r.key, r.value])); return { enabled: map.customer_integrity_enabled !== "false", scheduleHour: Number(map.customer_integrity_schedule_hour || "3"), lastRun: map.customer_integrity_last_run || null }; }),
  updateConfig: adminProcedure.input(z.object({ enabled: z.boolean(), scheduleHour: z.number().int().min(0).max(23) })).mutation(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    for (const [key, value] of Object.entries({ customer_integrity_enabled: String(input.enabled), customer_integrity_schedule_hour: String(input.scheduleHour) })) await db.insert(shopSettings).values({ key, value }).onConflictDoUpdate({ target: shopSettings.key, set: { value, updatedAt: new Date() } });
    return { success: true };
  }),
});
