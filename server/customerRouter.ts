/**
 * Customer Router – tRPC routes for customer management
 */
import { z } from "zod";
import { eq, desc, like } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { customers, orders, orderItems } from "../drizzle/schema.js";

const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().optional(),
  company: z.string().optional(),
  street: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  notes: z.string().optional(),
});

export const customerRouter = router({
  // List all customers
  list: adminProcedure
    .input(z.object({
      search: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let allCustomers = await db.select().from(customers).orderBy(desc(customers.updatedAt));

      if (input?.search) {
        const s = input.search.toLowerCase();
        allCustomers = allCustomers.filter(c =>
          c.name.toLowerCase().includes(s) ||
          (c.phone && c.phone.includes(s)) ||
          (c.email && c.email.toLowerCase().includes(s)) ||
          (c.company && c.company.toLowerCase().includes(s))
        );
      }

      return allCustomers.map(c => ({
        ...c,
        totalSpent: parseFloat(c.totalSpent),
      }));
    }),

  // Get single customer with purchase history
  get: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [customer] = await db.select().from(customers).where(eq(customers.id, input.id)).limit(1);
      if (!customer) throw new Error("Customer not found");

      // Get orders by email or phone
      const allOrders = await db.select().from(orders).orderBy(desc(orders.orderDate));
      const customerOrders = allOrders.filter(o =>
        (customer.email && o.email.toLowerCase() === customer.email.toLowerCase()) ||
        (customer.phone && o.phone === customer.phone)
      );

      // Get items for these orders
      const orderIds = customerOrders.map(o => o.orderId);
      let items: any[] = [];
      if (orderIds.length > 0) {
        const allItems = await db.select().from(orderItems);
        items = allItems.filter(i => orderIds.includes(i.orderId));
      }

      const ordersWithItems = customerOrders.map(o => ({
        ...o,
        total: parseFloat(o.total),
        items: items.filter(i => i.orderId === o.orderId).map(i => ({
          ...i,
          price: parseFloat(i.price),
        })),
      }));

      return {
        ...customer,
        totalSpent: parseFloat(customer.totalSpent),
        orders: ordersWithItems,
      };
    }),

  // Create customer
  create: adminProcedure
    .input(customerSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [inserted] = await db.insert(customers).values({
        name: input.name,
        phone: input.phone || null,
        email: input.email || null,
        company: input.company || null,
        street: input.street || null,
        zip: input.zip || null,
        city: input.city || null,
        country: input.country || null,
        notes: input.notes || null,
      }).returning();

      return { success: true, id: inserted.id };
    }),

  // Update customer
  update: adminProcedure
    .input(z.object({ id: z.number() }).merge(customerSchema.partial()))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { id, ...data } = input;
      const updateData: Record<string, any> = {};

      if (data.name !== undefined) updateData.name = data.name;
      if (data.phone !== undefined) updateData.phone = data.phone || null;
      if (data.email !== undefined) updateData.email = data.email || null;
      if (data.company !== undefined) updateData.company = data.company || null;
      if (data.street !== undefined) updateData.street = data.street || null;
      if (data.zip !== undefined) updateData.zip = data.zip || null;
      if (data.city !== undefined) updateData.city = data.city || null;
      if (data.country !== undefined) updateData.country = data.country || null;
      if (data.notes !== undefined) updateData.notes = data.notes || null;

      await db.update(customers).set(updateData).where(eq(customers.id, id));

      return { success: true };
    }),

  // Delete customer
  delete: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.delete(customers).where(eq(customers.id, input.id));
      return { success: true };
    }),

  // Search customer by phone/email (for auto-linking)
  search: adminProcedure
    .input(z.object({
      phone: z.string().optional(),
      email: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const allCustomers = await db.select().from(customers);

      if (input.phone) {
        const found = allCustomers.find(c => c.phone === input.phone);
        if (found) return { ...found, totalSpent: parseFloat(found.totalSpent) };
      }

      if (input.email) {
        const found = allCustomers.find(c => c.email && c.email.toLowerCase() === input.email!.toLowerCase());
        if (found) return { ...found, totalSpent: parseFloat(found.totalSpent) };
      }

      return null;
    }),
});
