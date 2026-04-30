/**
 * Invoice Router – persistent server-side invoice storage
 * Replaces browser localStorage for invoice persistence.
 */
import { z } from "zod";
import { eq, desc, and, gte, lte } from "drizzle-orm";
import { router, protectedProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { invoices } from "../drizzle/schema.js";

const storedInvoiceSchema = z.object({
  invoiceNumber: z.string(),
  orderNumber: z.string(),
  date: z.string(),
  dateISO: z.string(),
  totalGross: z.number(),
  html: z.string(),
  items: z.array(z.object({
    sku: z.string(),
    quantity: z.number(),
    unitPriceGross: z.number(),
  })).default([]),
  splitIndex: z.number().optional(),
  splitTotal: z.number().optional(),
});

export const invoiceRouter = router({
  /** Save or update a single invoice */
  save: protectedProcedure
    .input(storedInvoiceSchema)
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.invoiceNumber, input.invoiceNumber))
        .limit(1);

      const data = {
        invoiceNumber: input.invoiceNumber,
        orderNumber: input.orderNumber,
        date: input.date,
        dateISO: input.dateISO,
        totalGross: String(input.totalGross),
        html: input.html,
        items: JSON.stringify(input.items),
        splitIndex: input.splitIndex ?? null,
        splitTotal: input.splitTotal ?? null,
      };

      if (existing.length > 0) {
        await db.update(invoices).set(data).where(eq(invoices.invoiceNumber, input.invoiceNumber));
      } else {
        await db.insert(invoices).values(data);
      }
      return { success: true };
    }),

  /** Save multiple invoices at once (batch import from localStorage) */
  saveBatch: protectedProcedure
    .input(z.array(storedInvoiceSchema))
    .mutation(async ({ input }) => {
      const db = getDb();
      let saved = 0;
      let skipped = 0;

      for (const inv of input) {
        const existing = await db
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.invoiceNumber, inv.invoiceNumber))
          .limit(1);

        if (existing.length > 0) {
          skipped++;
          continue;
        }

        await db.insert(invoices).values({
          invoiceNumber: inv.invoiceNumber,
          orderNumber: inv.orderNumber,
          date: inv.date,
          dateISO: inv.dateISO,
          totalGross: String(inv.totalGross),
          html: inv.html,
          items: JSON.stringify(inv.items),
          splitIndex: inv.splitIndex ?? null,
          splitTotal: inv.splitTotal ?? null,
        });
        saved++;
      }

      return { saved, skipped };
    }),

  /** Get all invoices (sorted by date desc) */
  getAll: protectedProcedure
    .query(async () => {
      const db = getDb();
      const rows = await db
        .select()
        .from(invoices)
        .orderBy(desc(invoices.dateISO), desc(invoices.createdAt));

      return rows.map(r => ({
        invoiceNumber: r.invoiceNumber,
        orderNumber: r.orderNumber,
        date: r.date,
        dateISO: r.dateISO,
        totalGross: parseFloat(r.totalGross),
        html: r.html,
        items: JSON.parse(r.items || "[]"),
        splitIndex: r.splitIndex ?? undefined,
        splitTotal: r.splitTotal ?? undefined,
        createdAt: r.createdAt.toISOString(),
      }));
    }),

  /** Get invoices for a specific order */
  getByOrder: protectedProcedure
    .input(z.object({ orderNumber: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db
        .select()
        .from(invoices)
        .where(eq(invoices.orderNumber, input.orderNumber))
        .orderBy(invoices.invoiceNumber);

      return rows.map(r => ({
        invoiceNumber: r.invoiceNumber,
        orderNumber: r.orderNumber,
        date: r.date,
        dateISO: r.dateISO,
        totalGross: parseFloat(r.totalGross),
        html: r.html,
        items: JSON.parse(r.items || "[]"),
        splitIndex: r.splitIndex ?? undefined,
        splitTotal: r.splitTotal ?? undefined,
        createdAt: r.createdAt.toISOString(),
      }));
    }),

  /** Delete all invoices for an order */
  deleteByOrder: protectedProcedure
    .input(z.object({ orderNumber: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(invoices).where(eq(invoices.orderNumber, input.orderNumber));
      return { success: true };
    }),
});
