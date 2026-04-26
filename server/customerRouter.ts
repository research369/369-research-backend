/**
 * Customer Router – tRPC routes for CRM / customer management
 * Features: CRUD, advanced filtering, communication history, email sending, CSV export
 */
import { z } from "zod";
import { eq, desc, sql, and, gte, lte, like, or } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { customers, orders, orderItems, customerCommunications, emailTemplates, emailCampaigns } from "../drizzle/schema.js";

const RESEND_API_URL = "https://api.resend.com/emails";

const customerSchema = z.object({
  name: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  company: z.string().optional(),
  street: z.string().optional(),
  houseNumber: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  tags: z.string().optional(), // JSON array string
  source: z.string().optional(),
  notes: z.string().optional(),
});

export const customerRouter = router({
  // List all customers with advanced filtering
  list: adminProcedure
    .input(z.object({
      search: z.string().optional(),
      tags: z.array(z.string()).optional(),
      city: z.string().optional(),
      zip: z.string().optional(),
      country: z.string().optional(),
      minSpent: z.number().optional(),
      maxSpent: z.number().optional(),
      minOrders: z.number().optional(),
      source: z.string().optional(),
      hasEmail: z.boolean().optional(),
      orderDateFrom: z.string().optional(),
      orderDateTo: z.string().optional(),
      sortBy: z.enum(["name", "customerNumber", "totalSpent", "totalOrders", "lastOrderDate", "createdAt"]).optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let allCustomers = await db.select().from(customers).orderBy(desc(customers.updatedAt));

      // Apply filters
      if (input?.search) {
        const s = input.search.toLowerCase();
        allCustomers = allCustomers.filter(c =>
          c.name.toLowerCase().includes(s) ||
          (c.customerNumber && c.customerNumber.includes(s)) ||
          (c.phone && c.phone.includes(s)) ||
          (c.email && c.email.toLowerCase().includes(s)) ||
          (c.company && c.company.toLowerCase().includes(s)) ||
          (c.city && c.city.toLowerCase().includes(s)) ||
          (c.zip && c.zip.includes(s))
        );
      }

      if (input?.tags && input.tags.length > 0) {
        allCustomers = allCustomers.filter(c => {
          if (!c.tags) return false;
          try {
            const customerTags = JSON.parse(c.tags) as string[];
            return input.tags!.some(t => customerTags.includes(t));
          } catch { return false; }
        });
      }

      if (input?.city) {
        const city = input.city.toLowerCase();
        allCustomers = allCustomers.filter(c => c.city && c.city.toLowerCase().includes(city));
      }

      if (input?.zip) {
        allCustomers = allCustomers.filter(c => c.zip && c.zip.startsWith(input.zip!));
      }

      if (input?.country) {
        allCustomers = allCustomers.filter(c => c.country && c.country.toLowerCase() === input.country!.toLowerCase());
      }

      if (input?.minSpent !== undefined) {
        allCustomers = allCustomers.filter(c => parseFloat(c.totalSpent) >= input.minSpent!);
      }

      if (input?.maxSpent !== undefined) {
        allCustomers = allCustomers.filter(c => parseFloat(c.totalSpent) <= input.maxSpent!);
      }

      if (input?.minOrders !== undefined) {
        allCustomers = allCustomers.filter(c => c.totalOrders >= input.minOrders!);
      }

      if (input?.source) {
        allCustomers = allCustomers.filter(c => c.source === input.source);
      }

      if (input?.hasEmail === true) {
        allCustomers = allCustomers.filter(c => c.email && c.email.trim() !== "");
      }

      if (input?.orderDateFrom) {
        const from = new Date(input.orderDateFrom);
        allCustomers = allCustomers.filter(c => c.lastOrderDate && new Date(c.lastOrderDate) >= from);
      }

      if (input?.orderDateTo) {
        const to = new Date(input.orderDateTo);
        allCustomers = allCustomers.filter(c => c.lastOrderDate && new Date(c.lastOrderDate) <= to);
      }

      // Sort
      if (input?.sortBy) {
        const dir = input.sortDir === "asc" ? 1 : -1;
        allCustomers.sort((a, b) => {
          switch (input.sortBy) {
            case "name": return dir * a.name.localeCompare(b.name);
            case "customerNumber": return dir * ((a.customerNumber || "0").localeCompare(b.customerNumber || "0", undefined, { numeric: true }));
            case "totalSpent": return dir * (parseFloat(a.totalSpent) - parseFloat(b.totalSpent));
            case "totalOrders": return dir * (a.totalOrders - b.totalOrders);
            case "lastOrderDate": return dir * ((a.lastOrderDate?.getTime() || 0) - (b.lastOrderDate?.getTime() || 0));
            case "createdAt": return dir * (a.createdAt.getTime() - b.createdAt.getTime());
            default: return 0;
          }
        });
      }

      return allCustomers.map(c => ({
        ...c,
        totalSpent: parseFloat(c.totalSpent),
        tags: c.tags ? JSON.parse(c.tags) : [],
      }));
    }),

  // Get single customer with full history
  get: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [customer] = await db.select().from(customers).where(eq(customers.id, input.id)).limit(1);
      if (!customer) throw new Error("Customer not found");

      // Get orders linked by customerId, email, or phone
      // Placeholder emails/phones are excluded from matching to avoid false positives
      const PLACEHOLDER_EMAILS_GET = new Set([
        'keine@angabe.de', 'noemail@noemail.de', 'no@email.de', 'noreply@noreply.de',
        'placeholder@placeholder.de', 'test@test.de', 'info@info.de',
      ]);
      const allOrders = await db.select().from(orders).orderBy(desc(orders.orderDate));
      const emailKey = customer.email?.toLowerCase().trim() || '';
      const phoneKey = customer.phone?.trim() || '';
      const emailUsable = emailKey && !PLACEHOLDER_EMAILS_GET.has(emailKey);
      const phoneUsable = phoneKey && phoneKey.length > 4;
      const customerOrders = allOrders.filter(o => {
        // Primary: direct customerId link
        if (o.customerId === customer.id) return true;
        // Secondary: email match (only if customer has a real email)
        if (emailUsable && o.email.toLowerCase().trim() === emailKey) return true;
        // Tertiary: phone match (only if customer has a real phone)
        if (phoneUsable && o.phone.trim() === phoneKey) return true;
        return false;
      });
      // Deduplicate by orderId
      const seenIds = new Set<string>();
      const uniqueCustomerOrders = customerOrders.filter(o => {
        if (seenIds.has(o.orderId)) return false;
        seenIds.add(o.orderId);
        return true;
      });

      // Get items for these orders
      const orderIds = uniqueCustomerOrders.map(o => o.orderId);
      let items: any[] = [];
      if (orderIds.length > 0) {
        const allItems = await db.select().from(orderItems);
        items = allItems.filter(i => orderIds.includes(i.orderId));
      }

      const ordersWithItems = uniqueCustomerOrders.map(o => ({
        ...o,
        total: parseFloat(o.total),
        subtotal: parseFloat(o.subtotal),
        discount: parseFloat(o.discount),
        shipping: parseFloat(o.shipping),
        items: items.filter(i => i.orderId === o.orderId).map(i => ({
          ...i,
          price: parseFloat(i.price),
        })),
      }));

      // Get communication history
      const communications = await db.select()
        .from(customerCommunications)
        .where(eq(customerCommunications.customerId, customer.id))
        .orderBy(desc(customerCommunications.createdAt));

      return {
        ...customer,
        totalSpent: parseFloat(customer.totalSpent),
        tags: customer.tags ? JSON.parse(customer.tags) : [],
        orders: ordersWithItems,
        communications,
      };
    }),

  // Create customer (manual)
  create: adminProcedure
    .input(customerSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Generate next customer number
      const maxResult = await db.execute(sql`SELECT COALESCE(MAX(CAST(customer_number AS INTEGER)), 1209) as max_num FROM customers WHERE customer_number ~ '^[0-9]+$'`);
      const rows = maxResult as any;
      let nextNum = 1210;
      if (rows && rows.length > 0 && rows[0].max_num) {
        nextNum = parseInt(rows[0].max_num) + 1;
      } else if (rows?.rows && rows.rows.length > 0) {
        nextNum = parseInt(rows.rows[0].max_num) + 1;
      }
      if (nextNum < 1210) nextNum = 1210;

      const [inserted] = await db.insert(customers).values({
        customerNumber: String(nextNum),
        name: input.name,
        firstName: input.firstName || null,
        lastName: input.lastName || null,
        phone: input.phone || null,
        email: input.email || null,
        company: input.company || null,
        street: input.street || null,
        houseNumber: input.houseNumber || null,
        zip: input.zip || null,
        city: input.city || null,
        country: input.country || null,
        tags: input.tags || null,
        source: input.source || "manual",
        notes: input.notes || null,
      }).returning();

      return { success: true, id: inserted.id, customerNumber: inserted.customerNumber };
    }),

  // Update customer
  update: adminProcedure
    .input(z.object({ id: z.number() }).merge(customerSchema.partial()))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { id, ...data } = input;
      const updateData: Record<string, any> = { updatedAt: new Date() };

      if (data.name !== undefined) updateData.name = data.name;
      if (data.firstName !== undefined) updateData.firstName = data.firstName || null;
      if (data.lastName !== undefined) updateData.lastName = data.lastName || null;
      if (data.phone !== undefined) updateData.phone = data.phone || null;
      if (data.email !== undefined) updateData.email = data.email || null;
      if (data.company !== undefined) updateData.company = data.company || null;
      if (data.street !== undefined) updateData.street = data.street || null;
      if (data.houseNumber !== undefined) updateData.houseNumber = data.houseNumber || null;
      if (data.zip !== undefined) updateData.zip = data.zip || null;
      if (data.city !== undefined) updateData.city = data.city || null;
      if (data.country !== undefined) updateData.country = data.country || null;
      if (data.tags !== undefined) updateData.tags = data.tags || null;
      if (data.source !== undefined) updateData.source = data.source || null;
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

      // Also delete communications
      await db.delete(customerCommunications).where(eq(customerCommunications.customerId, input.id));
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
        if (found) return { ...found, totalSpent: parseFloat(found.totalSpent), tags: found.tags ? JSON.parse(found.tags) : [] };
      }

      if (input.email) {
        const found = allCustomers.find(c => c.email && c.email.toLowerCase() === input.email!.toLowerCase());
        if (found) return { ...found, totalSpent: parseFloat(found.totalSpent), tags: found.tags ? JSON.parse(found.tags) : [] };
      }

      return null;
    }),

  // Add communication (note, email log, etc.)
  addCommunication: adminProcedure
    .input(z.object({
      customerId: z.number(),
      type: z.enum(["email", "note", "whatsapp", "phone"]),
      subject: z.string().optional(),
      body: z.string().optional(),
      htmlBody: z.string().optional(),
      orderId: z.string().optional(),
      status: z.enum(["sent", "failed", "draft", "logged"]).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [comm] = await db.insert(customerCommunications).values({
        customerId: input.customerId,
        type: input.type,
        status: input.status || "logged",
        subject: input.subject || null,
        body: input.body || null,
        htmlBody: input.htmlBody || null,
        orderId: input.orderId || null,
        createdBy: "admin",
      }).returning();

      return { success: true, id: comm.id };
    }),

  // Get communications for a customer
  getCommunications: adminProcedure
    .input(z.object({ customerId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      return await db.select()
        .from(customerCommunications)
        .where(eq(customerCommunications.customerId, input.customerId))
        .orderBy(desc(customerCommunications.createdAt));
    }),

  // Send email to a single customer
  sendEmail: adminProcedure
    .input(z.object({
      customerId: z.number(),
      subject: z.string().min(1),
      htmlBody: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [customer] = await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
      if (!customer) throw new Error("Customer not found");
      if (!customer.email) throw new Error("Customer has no email address");

      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error("RESEND_API_KEY not configured");

      // Send email via Resend
      const response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "369 Research <noreply@369research.eu>",
          to: [customer.email],
          subject: input.subject,
          html: input.htmlBody,
        }),
      });

      const success = response.ok;
      const result = success ? await response.json() : null;

      // Log communication
      await db.insert(customerCommunications).values({
        customerId: input.customerId,
        type: "email",
        status: success ? "sent" : "failed",
        subject: input.subject,
        htmlBody: input.htmlBody,
        recipientEmail: customer.email,
        senderName: "369 Research",
        createdBy: "admin",
      });

      if (!success) {
        const errorText = await response.text();
        throw new Error(`Email failed: ${errorText}`);
      }

      return { success: true, emailId: result?.id };
    }),

  // Send bulk email to selected customers
  sendBulkEmail: adminProcedure
    .input(z.object({
      customerIds: z.array(z.number()),
      subject: z.string().min(1),
      htmlBody: z.string().min(1),
      campaignName: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error("RESEND_API_KEY not configured");

      // Get all selected customers with email
      const allCustomers = await db.select().from(customers);
      const selectedCustomers = allCustomers.filter(c =>
        input.customerIds.includes(c.id) && c.email && c.email.trim() !== ""
      );

      if (selectedCustomers.length === 0) {
        throw new Error("No customers with email addresses selected");
      }

      // Create campaign record
      const [campaign] = await db.insert(emailCampaigns).values({
        name: input.campaignName || `Kampagne ${new Date().toLocaleDateString("de-DE")}`,
        subject: input.subject,
        htmlBody: input.htmlBody,
        status: "sending",
        recipientCount: selectedCustomers.length,
        sentCount: 0,
        failedCount: 0,
      }).returning();

      let sentCount = 0;
      let failedCount = 0;

      // Send emails one by one (Resend rate limit friendly)
      for (const customer of selectedCustomers) {
        try {
          // Replace placeholders in HTML
          let personalizedHtml = input.htmlBody
            .replace(/\{\{name\}\}/g, customer.name)
            .replace(/\{\{firstName\}\}/g, customer.firstName || customer.name.split(" ")[0])
            .replace(/\{\{lastName\}\}/g, customer.lastName || "")
            .replace(/\{\{customerNumber\}\}/g, customer.customerNumber || "")
            .replace(/\{\{email\}\}/g, customer.email || "")
            .replace(/\{\{company\}\}/g, customer.company || "");

          const response = await fetch(RESEND_API_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: "369 Research <noreply@369research.eu>",
              to: [customer.email!],
              subject: input.subject,
              html: personalizedHtml,
            }),
          });

          const success = response.ok;

          // Log communication
          await db.insert(customerCommunications).values({
            customerId: customer.id,
            type: "email",
            status: success ? "sent" : "failed",
            subject: input.subject,
            htmlBody: personalizedHtml,
            recipientEmail: customer.email,
            senderName: "369 Research",
            campaignId: campaign.id,
            createdBy: "admin",
          });

          if (success) {
            sentCount++;
          } else {
            failedCount++;
          }

          // Small delay to respect rate limits
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err) {
          failedCount++;
          console.warn(`[Email] Failed to send to ${customer.email}:`, err);
        }
      }

      // Update campaign status
      await db.update(emailCampaigns).set({
        status: failedCount === selectedCustomers.length ? "failed" : "sent",
        sentCount,
        failedCount,
        sentAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(emailCampaigns.id, campaign.id));

      return {
        success: true,
        campaignId: campaign.id,
        sentCount,
        failedCount,
        totalRecipients: selectedCustomers.length,
      };
    }),

  // Get all unique tags
  getTags: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const allCustomers = await db.select({ tags: customers.tags }).from(customers);
    const tagSet = new Set<string>();
    for (const c of allCustomers) {
      if (c.tags) {
        try {
          const parsed = JSON.parse(c.tags) as string[];
          parsed.forEach(t => tagSet.add(t));
        } catch {}
      }
    }
    return Array.from(tagSet).sort();
  }),

  // Export customers as CSV data
  export: adminProcedure
    .input(z.object({
      customerIds: z.array(z.number()).optional(), // if empty, export all
      fields: z.array(z.string()).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      let allCustomers = await db.select().from(customers).orderBy(desc(customers.updatedAt));

      if (input?.customerIds && input.customerIds.length > 0) {
        allCustomers = allCustomers.filter(c => input.customerIds!.includes(c.id));
      }

      // Build CSV
      const headers = ["Kundennummer", "Name", "Vorname", "Nachname", "E-Mail", "Telefon", "Firma", "Straße", "Hausnummer", "PLZ", "Stadt", "Land", "Tags", "Quelle", "Bestellungen", "Umsatz", "Erste Bestellung", "Letzte Bestellung", "Notizen"];
      const rows = allCustomers.map(c => [
        c.customerNumber || "",
        c.name,
        c.firstName || "",
        c.lastName || "",
        c.email || "",
        c.phone || "",
        c.company || "",
        c.street || "",
        c.houseNumber || "",
        c.zip || "",
        c.city || "",
        c.country || "",
        c.tags ? JSON.parse(c.tags).join(", ") : "",
        c.source || "",
        String(c.totalOrders),
        parseFloat(c.totalSpent).toFixed(2),
        c.firstOrderDate ? new Date(c.firstOrderDate).toLocaleDateString("de-DE") : "",
        c.lastOrderDate ? new Date(c.lastOrderDate).toLocaleDateString("de-DE") : "",
        (c.notes || "").replace(/"/g, '""'),
      ]);

      const csvContent = [
        headers.join(";"),
        ...rows.map(r => r.map(v => `"${v}"`).join(";")),
      ].join("\n");

      return { csv: csvContent, count: allCustomers.length };
    }),

  // Email Templates CRUD
  listTemplates: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return await db.select().from(emailTemplates).orderBy(desc(emailTemplates.updatedAt));
  }),

  createTemplate: adminProcedure
    .input(z.object({
      name: z.string().min(1),
      subject: z.string().min(1),
      htmlBody: z.string().min(1),
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [template] = await db.insert(emailTemplates).values({
        name: input.name,
        subject: input.subject,
        htmlBody: input.htmlBody,
        description: input.description || null,
      }).returning();

      return { success: true, id: template.id };
    }),

  updateTemplate: adminProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().optional(),
      subject: z.string().optional(),
      htmlBody: z.string().optional(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { id, ...data } = input;
      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (data.name !== undefined) updateData.name = data.name;
      if (data.subject !== undefined) updateData.subject = data.subject;
      if (data.htmlBody !== undefined) updateData.htmlBody = data.htmlBody;
      if (data.description !== undefined) updateData.description = data.description;

      await db.update(emailTemplates).set(updateData).where(eq(emailTemplates.id, id));
      return { success: true };
    }),

  deleteTemplate: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.delete(emailTemplates).where(eq(emailTemplates.id, input.id));
      return { success: true };
    }),

  // List campaigns
  listCampaigns: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return await db.select().from(emailCampaigns).orderBy(desc(emailCampaigns.createdAt));
  }),

  // Backfill: Create customers from existing orders
  backfillFromOrders: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const allOrders = await db.select().from(orders).orderBy(orders.orderDate);
    const existingCustomers = await db.select().from(customers);

    let created = 0;
    let linked = 0;

    for (const order of allOrders) {
      const email = order.email.toLowerCase().trim();
      const phone = order.phone.trim();
      const fullName = `${order.firstName} ${order.lastName}`;

      // Check if customer already exists
      let existing = existingCustomers.find(c =>
        (c.email && c.email.toLowerCase() === email) ||
        (c.phone && c.phone === phone)
      );

      if (existing) {
        // Link order if not already linked
        if (!order.customerId) {
          await db.update(orders).set({ customerId: existing.id }).where(eq(orders.id, order.id));
          linked++;
        }
        // Update totals
        const orderTotal = parseFloat(order.total);
        await db.update(customers).set({
          totalOrders: existing.totalOrders + 1,
          totalSpent: (parseFloat(existing.totalSpent) + orderTotal).toFixed(2),
          lastOrderDate: order.orderDate,
          firstName: order.firstName,
          lastName: order.lastName,
          street: order.street,
          houseNumber: order.houseNumber,
          zip: order.zip,
          city: order.city,
          country: order.country,
          updatedAt: new Date(),
        }).where(eq(customers.id, existing.id));
        // Update local reference
        existing.totalOrders += 1;
        existing.totalSpent = (parseFloat(existing.totalSpent) + orderTotal).toFixed(2);
      } else {
        // Generate customer number
        const maxResult = await db.execute(sql`SELECT COALESCE(MAX(CAST(customer_number AS INTEGER)), 1209) as max_num FROM customers WHERE customer_number ~ '^[0-9]+$'`);
        const rows = maxResult as any;
        let nextNum = 1210;
        if (rows && rows.length > 0 && rows[0].max_num) {
          nextNum = parseInt(rows[0].max_num) + 1;
        } else if (rows?.rows && rows.rows.length > 0) {
          nextNum = parseInt(rows.rows[0].max_num) + 1;
        }
        if (nextNum < 1210) nextNum = 1210;

        const [newCustomer] = await db.insert(customers).values({
          customerNumber: String(nextNum),
          name: fullName,
          firstName: order.firstName,
          lastName: order.lastName,
          phone: phone || null,
          email: email || null,
          company: order.company || null,
          street: order.street,
          houseNumber: order.houseNumber,
          zip: order.zip,
          city: order.city,
          country: order.country,
          source: "backfill",
          totalOrders: 1,
          totalSpent: order.total,
          firstOrderDate: order.orderDate,
          lastOrderDate: order.orderDate,
        }).returning();

        // Link order
        await db.update(orders).set({ customerId: newCustomer.id }).where(eq(orders.id, order.id));

        existingCustomers.push(newCustomer);
        created++;
        linked++;
      }
    }

    return { success: true, created, linked, totalOrders: allOrders.length };
  }),

  // Rebuild customer stats (totalOrders, totalSpent, firstOrderDate, lastOrderDate) from actual orders
  rebuildCustomerStats: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const allCustomers = await db.select().from(customers);
    const allOrders = await db.select().from(orders);

    // Placeholder/dummy emails that should NOT be used for matching
    const PLACEHOLDER_EMAILS = new Set([
      'keine@angabe.de', 'noemail@noemail.de', 'no@email.de', 'noreply@noreply.de',
      'placeholder@placeholder.de', 'test@test.de', 'info@info.de',
    ]);
    // Placeholder phones
    const PLACEHOLDER_PHONES = new Set(['0000000', '00000000000', '']);

    // Build a map: email -> list of customerIds that use it
    // If multiple customers share the same email, email-matching is ambiguous → skip it
    const emailToCustomerIds: Record<string, number[]> = {};
    for (const c of allCustomers) {
      if (c.email && !PLACEHOLDER_EMAILS.has(c.email.toLowerCase().trim())) {
        const key = c.email.toLowerCase().trim();
        if (!emailToCustomerIds[key]) emailToCustomerIds[key] = [];
        emailToCustomerIds[key].push(c.id);
      }
    }
    // Same for phone
    const phoneToCustomerIds: Record<string, number[]> = {};
    for (const c of allCustomers) {
      if (c.phone && !PLACEHOLDER_PHONES.has(c.phone.trim())) {
        const key = c.phone.trim();
        if (!phoneToCustomerIds[key]) phoneToCustomerIds[key] = [];
        phoneToCustomerIds[key].push(c.id);
      }
    }

    let updated = 0;
    for (const customer of allCustomers) {
      const emailKey = customer.email?.toLowerCase().trim() || '';
      const phoneKey = customer.phone?.trim() || '';
      // Only use email for matching if it's unique (not shared with other customers) and not a placeholder
      const emailIsUsable = emailKey && !PLACEHOLDER_EMAILS.has(emailKey) && (emailToCustomerIds[emailKey]?.length ?? 0) === 1;
      // Only use phone for matching if it's unique and not a placeholder
      const phoneIsUsable = phoneKey && !PLACEHOLDER_PHONES.has(phoneKey) && (phoneToCustomerIds[phoneKey]?.length ?? 0) === 1;

      const customerOrders = allOrders.filter(o => {
        // Primary: direct customerId link (always reliable)
        if (o.customerId === customer.id) return true;
        // Secondary: unique email match
        if (emailIsUsable && o.email.toLowerCase().trim() === emailKey) return true;
        // Tertiary: unique phone match
        if (phoneIsUsable && o.phone.trim() === phoneKey) return true;
        return false;
      });

      // Deduplicate by orderId (avoid counting same order twice)
      const seen = new Set<string>();
      const uniqueOrders = customerOrders.filter(o => {
        if (seen.has(o.orderId)) return false;
        seen.add(o.orderId);
        return true;
      });

      const totalOrders = uniqueOrders.length;
      const totalSpent = uniqueOrders.reduce((sum, o) => sum + parseFloat(o.total), 0);
      const orderDates = uniqueOrders.map(o => o.orderDate).filter(Boolean) as Date[];
      const firstOrderDate = orderDates.length > 0 ? new Date(Math.min(...orderDates.map(d => d.getTime()))) : null;
      const lastOrderDate = orderDates.length > 0 ? new Date(Math.max(...orderDates.map(d => d.getTime()))) : null;
      await db.update(customers).set({
        totalOrders,
        totalSpent: totalSpent.toFixed(2),
        firstOrderDate,
        lastOrderDate,
        updatedAt: new Date(),
      }).where(eq(customers.id, customer.id));
      updated++;
    }
    return { success: true, updated, totalCustomers: allCustomers.length };
  }),
});
