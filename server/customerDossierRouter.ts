import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { customerIssueCases, customerTagDefinitions, customers, orders, shopSettings } from "../drizzle/schema.js";

const issueStatus = z.enum(["open", "in_progress", "resolved", "archived"]);
const issueSeverity = z.enum(["low", "normal", "high", "critical"]);

function parseTags(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((tag) => String(tag).trim()).filter(Boolean);
  } catch {
    // Backwards compatibility for legacy comma-separated tags.
  }
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function uniqueTags(tags: string[]) {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function actor(ctx: { user?: { name?: string | null; username?: string | null } }) {
  return ctx.user?.name || ctx.user?.username || "admin";
}

function derivedStatus(paidOrderCount: number, totalSpent: number, tags: string[]) {
  const normalized = tags.map((tag) => tag.toLocaleLowerCase("de-DE"));
  if (normalized.includes("vip")) return { key: "vip", label: "VIP", color: "amber" };
  if (paidOrderCount >= 6 || totalSpent >= 1000) return { key: "vielbesteller", label: "Vielbesteller", color: "violet" };
  if (paidOrderCount >= 3) return { key: "stammkunde", label: "Stammkunde", color: "emerald" };
  if (paidOrderCount >= 1) return { key: "wiederkehrend", label: "Wiederkehrend", color: "blue" };
  return { key: "neukunde", label: "Neukunde", color: "sky" };
}

const PAID_STATUSES = new Set(["bezahlt", "gepackt", "versendet", "zugestellt"]);

export const customerDossierRouter = router({
  tagDefinitions: adminProcedure.input(z.object({ activeOnly: z.boolean().optional().default(true) }).optional()).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    const rows = await db.select().from(customerTagDefinitions).orderBy(asc(customerTagDefinitions.sortOrder), asc(customerTagDefinitions.label));
    return (input?.activeOnly === false ? rows : rows.filter((row) => row.isActive === 1));
  }),

  saveTagDefinition: adminProcedure.input(z.object({
    id: z.number().optional(), tagKey: z.string().trim().min(2).max(80).regex(/^[a-z0-9_-]+$/), label: z.string().trim().min(2).max(120),
    color: z.enum(["slate", "sky", "blue", "emerald", "violet", "amber", "orange", "rose"]).default("slate"),
    description: z.string().max(1000).optional(), sortOrder: z.number().int().min(0).max(9999).default(999), isActive: z.boolean().default(true),
  })).mutation(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    const values = { tagKey: input.tagKey, label: input.label, color: input.color, description: input.description || null, sortOrder: input.sortOrder, isActive: input.isActive ? 1 : 0, updatedAt: new Date() };
    if (input.id) {
      await db.update(customerTagDefinitions).set(values).where(eq(customerTagDefinitions.id, input.id));
      return { id: input.id };
    }
    const [created] = await db.insert(customerTagDefinitions).values(values).returning({ id: customerTagDefinitions.id });
    return created;
  }),

  setCustomerTags: adminProcedure.input(z.object({ customerId: z.number().int().positive(), tags: z.array(z.string().trim().min(1).max(120)).max(30) })).mutation(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    const [customer] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1);
    if (!customer) throw new Error("Kunde nicht gefunden");
    const tags = uniqueTags(input.tags);
    await db.update(customers).set({ tags: JSON.stringify(tags), updatedAt: new Date() }).where(eq(customers.id, input.customerId));
    return { tags };
  }),

  overview: adminProcedure.input(z.object({ customerId: z.number().int().positive() })).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    const [customer] = await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
    if (!customer) throw new Error("Kunde nicht gefunden");

    const [definitions, allOrders, allCases, settings] = await Promise.all([
      db.select().from(customerTagDefinitions).orderBy(asc(customerTagDefinitions.sortOrder), asc(customerTagDefinitions.label)),
      db.select().from(orders).where(eq(orders.customerId, customer.id)).orderBy(desc(orders.orderDate)),
      db.select().from(customerIssueCases).where(eq(customerIssueCases.customerId, customer.id)).orderBy(desc(customerIssueCases.occurredAt)),
      db.select().from(shopSettings).where(inArray(shopSettings.key, ["customer_dossier_issue_categories"])),
    ]);
    const rawTags = parseTags(customer.tags);
    const categoriesSetting = settings.find((item) => item.key === "customer_dossier_issue_categories")?.value;
    let issueCategories = ["Versand nicht zugestellt", "Ware beschädigt", "Falscher Artikel", "Adressproblem", "Zahlungs-/Bestellproblem", "Qualitäts-/Serviceproblem", "Sonstiges"];
    try {
      const parsed = JSON.parse(categoriesSetting || "[]");
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.trim())) issueCategories = parsed;
    } catch { /* Keep a safe default when a setting is malformed. */ }
    const definitionsByKey = new Map(definitions.map((definition) => [definition.tagKey, definition]));
    const tags = rawTags.map((tag) => {
      const key = tag.toLocaleLowerCase("de-DE").replace(/\s+/g, "-");
      const definition = definitionsByKey.get(key) || definitions.find((row) => row.label.toLocaleLowerCase("de-DE") === tag.toLocaleLowerCase("de-DE"));
      return { key: definition?.tagKey || key, label: definition?.label || tag, color: definition?.color || "slate" };
    });
    const paidOrders = allOrders.filter((order) => PAID_STATUSES.has(order.status));
    const totalSpent = paidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0);
    const status = derivedStatus(paidOrders.length, totalSpent, rawTags);
    const openCases = allCases.filter((item) => item.status === "open" || item.status === "in_progress");

    const orderMap = new Map(allOrders.map((order) => [order.orderId, order]));
    const toCaseDto = (item: typeof allCases[number]) => ({
      id: item.id, customerId: item.customerId, orderId: item.orderId, category: item.category, severity: item.severity,
      status: item.status, title: item.title, details: item.details, occurredAt: item.occurredAt, createdAt: item.createdAt,
      createdBy: item.createdBy, resolvedAt: item.resolvedAt, resolvedBy: item.resolvedBy, resolutionNote: item.resolutionNote,
      order: item.orderId ? (() => { const order = orderMap.get(item.orderId!); return order ? { orderId: order.orderId, status: order.status, total: Number(order.total || 0), orderDate: order.orderDate } : null; })() : null,
    });
    return {
      customer: { id: customer.id, customerNumber: customer.customerNumber, name: customer.name, email: customer.email, phone: customer.phone },
      status, tags, tagDefinitions: definitions.filter((row) => row.isActive === 1), issueCategories,
      metrics: { paidOrders: paidOrders.length, totalSpent, lastOrderAt: allOrders[0]?.orderDate || null },
      openCases: openCases.map(toCaseDto), recentCases: allCases.slice(0, 20).map(toCaseDto),
    };
  }),

  createCase: adminProcedure.input(z.object({
    customerId: z.number().int().positive(), orderId: z.string().trim().max(32).optional(),
    category: z.string().trim().min(2).max(64), severity: issueSeverity.default("normal"),
    title: z.string().trim().min(3).max(240), details: z.string().trim().min(3).max(5000), occurredAt: z.coerce.date().optional(),
  })).mutation(async ({ input, ctx }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    const [customer] = await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
    if (!customer) throw new Error("Kunde nicht gefunden");
    let linkedOrder: typeof orders.$inferSelect | undefined;
    if (input.orderId) {
      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Verknüpfte Bestellung nicht gefunden");
      if (order.customerId !== customer.id) throw new Error("Bestellung gehört nicht zu diesem Kunden");
      linkedOrder = order;
    }
    const snapshot = {
      customer: { id: customer.id, customerNumber: customer.customerNumber, name: customer.name, email: customer.email, phone: customer.phone },
      order: linkedOrder ? { orderId: linkedOrder.orderId, status: linkedOrder.status, total: Number(linkedOrder.total || 0), orderDate: linkedOrder.orderDate } : null,
    };
    const [created] = await db.insert(customerIssueCases).values({
      customerId: customer.id, orderId: input.orderId || null, category: input.category, severity: input.severity, status: "open",
      title: input.title, details: input.details, occurredAt: input.occurredAt || new Date(), createdBy: actor(ctx), contextSnapshotJson: JSON.stringify(snapshot),
    }).returning({ id: customerIssueCases.id });
    return created;
  }),

  resolveCase: adminProcedure.input(z.object({
    id: z.number().int().positive(), status: z.enum(["in_progress", "resolved", "archived"]), resolutionNote: z.string().trim().max(3000).optional(),
  })).mutation(async ({ input, ctx }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    const isClosed = input.status === "resolved" || input.status === "archived";
    await db.update(customerIssueCases).set({
      status: input.status,
      resolutionNote: input.resolutionNote || null,
      resolvedAt: isClosed ? new Date() : null,
      resolvedBy: isClosed ? actor(ctx) : null,
    }).where(eq(customerIssueCases.id, input.id));
    return { success: true };
  }),

  casesForOrders: adminProcedure.input(z.object({ orderIds: z.array(z.string().trim().min(1)).max(100) })).query(async ({ input }) => {
    const db = await getDb(); if (!db) throw new Error("Datenbank nicht verfügbar");
    if (input.orderIds.length === 0) return [];
    const rows = await db.select().from(customerIssueCases).where(inArray(customerIssueCases.orderId, input.orderIds)).orderBy(desc(customerIssueCases.occurredAt));
    return rows.filter((row) => row.status === "open" || row.status === "in_progress");
  }),
});
