import {nextCustomerNumber,requireCustomerNumberMigration} from './customerNumberService.js';
import {checkCustomerCreationMaintenance} from './customerCreationMaintenance.js';
/**
 * Customer Router – tRPC routes for CRM / customer management
 * Features: CRUD, advanced filtering, communication history, email sending, CSV export
 */
import { z } from "zod";
import { eq, desc, sql, and, gte, lte, like, or, inArray } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb, getPool } from "./db.js";
import { customers, orders, orderItems, customerCommunications, emailTemplates, emailCampaigns, partners } from "../drizzle/schema.js";
import { queueCustomerDuplicateReview } from "./customerIntegrityService.js";
import { persistAddressValidation, validateGermanAddress } from "./addressValidationService.js";
import { calculateCustomerOrderMetrics } from "./customerOrderMetrics.js";
import { isCommercialOrder, isCompletedCommercialOrder } from "./commercialOrderMetrics.js";
import {
  activateCustomerOrderBlock,
  getActiveCustomerOrderBlockForCustomer,
  getActiveCustomerOrderBlocksForCustomers,
  revokeCustomerOrderBlock,
} from "./customerOrderBlockService.js";
import { getPersonalPromoAssignmentsForCustomerIds } from "./customerPromoAssignmentService.js";

import { resolveCheckoutCustomerDataChange, normalizeCustomerMatchEmail, normalizeCustomerMatchPhone } from "./customerDataChangeService.js";
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
  dhlPostNumber: z.string().optional(), // DHL-Postnummer für Packstation-Lieferungen
  communicationLanguage: z.enum(["de", "en"]).optional(),
  // Nur nach sichtbarer Warnung möglich; wird serverseitig erneut geprüft.
  addressValidationOverride: z.object({ confirmed: z.literal(true) }).optional(),
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

      // Enrich with partner code for customers who have an assigned partner
      const partnerIds = [...new Set(allCustomers.map(c => c.acquiredByPartnerId).filter((id): id is number => id !== null && id !== undefined))];
      const partnerCodeMap: Record<number, string> = {};
      if (partnerIds.length > 0) {
        const partnerRows = await db.select({ id: partners.id, code: partners.code }).from(partners);
        for (const p of partnerRows) {
          if (partnerIds.includes(p.id)) partnerCodeMap[p.id] = p.code;
        }
      }
      const activeOrderBlocks = await getActiveCustomerOrderBlocksForCustomers(allCustomers.map((customer) => customer.id));
      return allCustomers.map(c => ({
        ...c,
        totalSpent: parseFloat(c.totalSpent),
        tags: c.tags ? JSON.parse(c.tags) : [],
        acquiredByPartnerCode: c.acquiredByPartnerId ? (partnerCodeMap[c.acquiredByPartnerId] || null) : null,
        orderBlock: activeOrderBlocks.get(c.id) ?? null,
      }));
    }),

  // One authoritative whole-CRM summary: every active order is counted exactly
  // once, independently from duplicate identities or the current list filters.
  summary: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const [allCustomers, allOrders] = await Promise.all([
      db.select({ id: customers.id, email: customers.email }).from(customers),
      db.select({ customerId: orders.customerId, total: orders.total, status: orders.status }).from(orders),
    ]);
    const activeOrders = allOrders.filter(isCommercialOrder);
    const customerIds = new Set(allCustomers.map((customer) => customer.id));
    const linkedActiveOrders = activeOrders.filter((order) => order.customerId !== null && customerIds.has(order.customerId));
    const unlinkedActiveOrders = activeOrders.filter((order) => order.customerId === null || !customerIds.has(order.customerId));

    return {
      totalCustomers: allCustomers.length,
      customersWithEmail: allCustomers.filter((customer) => Boolean(customer.email?.trim())).length,
      totalOrders: activeOrders.length,
      totalRevenue: activeOrders.reduce((sum, order) => sum + parseFloat(order.total), 0),
      linkedOrderCount: linkedActiveOrders.length,
      linkedRevenue: linkedActiveOrders.reduce((sum, order) => sum + parseFloat(order.total), 0),
      unlinkedOrderCount: unlinkedActiveOrders.length,
      unlinkedRevenue: unlinkedActiveOrders.reduce((sum, order) => sum + parseFloat(order.total), 0),
    };
  }),

  // Get single customer with full history
  get: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [customer] = await db.select().from(customers).where(eq(customers.id, input.id)).limit(1);
      if (!customer) throw new Error("Customer not found");

      // A historical order belongs to precisely one customer record. Never infer
      // history from a shared e-mail address or phone number here: that was the
      // source of CRM total overcounts and misleading customer histories.
      const uniqueCustomerOrders = await db.select()
        .from(orders)
        .where(eq(orders.customerId, customer.id))
        .orderBy(desc(orders.orderDate));

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
      const orderBlock = await getActiveCustomerOrderBlockForCustomer(customer.id);
      const personalPromoAssignments = await getPersonalPromoAssignmentsForCustomerIds([customer.id]);

      return {
        ...customer,
        totalSpent: parseFloat(customer.totalSpent),
        tags: customer.tags ? JSON.parse(customer.tags) : [],
        orders: ordersWithItems,
        communications,
        orderBlock,
        personalPromoCodes: personalPromoAssignments.get(customer.id) ?? [],
      };
    }),

  // An explicit block is always bound to the exact current e-mail and/or phone
  // stored on this individual record. A name, tag, city or address is never
  // used as a blocking criterion.
  blockOrders: adminProcedure
    .input(z.object({ customerId: z.number(), reason: z.string().trim().min(5).max(2_000) }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [customer] = await db.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
      if (!customer) throw new Error("Kunde nicht gefunden");
      const actor = ctx.user.name || ctx.user.username || "Master-Admin";
      const orderBlock = await activateCustomerOrderBlock({
        customerId: customer.id,
        email: customer.email,
        phone: customer.phone,
        reason: input.reason,
        actor,
      });
      return { success: true, orderBlock };
    }),

  unblockOrders: adminProcedure
    .input(z.object({ customerId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const actor = ctx.user.name || ctx.user.username || "Master-Admin";
      const changed = await revokeCustomerOrderBlock({ customerId: input.customerId, actor });
      return { success: true, changed };
    }),

  // Create customer (manual)
  create: adminProcedure
    .input(customerSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await checkCustomerCreationMaintenance('customer.create','mutation',await getPool());
      const addressHasInput = [input.street, input.houseNumber, input.zip, input.city, input.country].some((value) => !!value?.trim());
      const addressValidation = addressHasInput ? await validateGermanAddress({
        street: input.street || "", houseNumber: input.houseNumber || "", zip: input.zip || "", city: input.city || "", country: input.country || "",
      }) : null;
      const addressWarningNeedsConfirmation = !!addressValidation?.applicable && (addressValidation.status === "warning" || addressValidation.status === "unavailable");
      if (addressWarningNeedsConfirmation && input.addressValidationOverride?.confirmed !== true) {
        throw new Error(`ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH: ${addressValidation!.warnings.map((warning) => warning.message).join(" ")}`);
      }

      // Sequence is allocated once and reused for the inserted record lookup.
      const nextNum = await nextCustomerNumber(db);

      console.log(`[customer.create] houseNumber=${JSON.stringify(input.houseNumber)}, street=${JSON.stringify(input.street)}, zip=${JSON.stringify(input.zip)}, city=${JSON.stringify(input.city)}`);
      await db.insert(customers).values({
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
        dhlPostNumber: input.dhlPostNumber || null,
        tags: input.tags || null,
        source: input.source || "manual",
        notes: input.notes || null,
        communicationLanguage: input.communicationLanguage || "de",
      });

      // SELECT after INSERT - more robust than RETURNING (works on all DB systems)
      const [inserted] = await db.select().from(customers)
        .where(eq(customers.customerNumber, String(nextNum)))
        .limit(1);
      if (!inserted) throw new Error("Customer was not created");
      console.log(`[customer.create] saved houseNumber=${JSON.stringify(inserted.houseNumber)}`);
      if (addressWarningNeedsConfirmation && addressValidation) {
        await persistAddressValidation({
          input: { street: input.street || "", houseNumber: input.houseNumber || "", zip: input.zip || "", city: input.city || "", country: input.country || "" },
          result: addressValidation,
          context: "customer_create",
          customerId: inserted.id,
          overrideConfirmed: true,
          confirmedBy: "Master-Admin",
        });
      }
      try {
        await queueCustomerDuplicateReview(inserted.id, "customer_created", "customer.create");
      } catch (error) {
        console.warn("[Customer Integrity] Prüfung nach Kundenanlage fehlgeschlagen (nicht blockierend):", error);
      }

      return { success: true, id: inserted.id, customerNumber: inserted.customerNumber };
    }),

    // Update customer
  update: adminProcedure
    .input(z.object({ id: z.number() }).merge(customerSchema.partial()))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const { id, ...data } = input;
      const [existingCustomer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
      if (!existingCustomer) throw new Error("Kunde nicht gefunden");
      const addressFieldsChanged = ["street", "houseNumber", "zip", "city", "country"].some((field) => (data as any)[field] !== undefined);
      const effectiveAddress = {
        street: data.street ?? existingCustomer.street ?? "",
        houseNumber: data.houseNumber ?? existingCustomer.houseNumber ?? "",
        zip: data.zip ?? existingCustomer.zip ?? "",
        city: data.city ?? existingCustomer.city ?? "",
        country: data.country ?? existingCustomer.country ?? "",
      };
      const addressHasInput = Object.values(effectiveAddress).some((value) => !!String(value).trim());
      const addressValidation = addressFieldsChanged && addressHasInput ? await validateGermanAddress(effectiveAddress) : null;
      const addressWarningNeedsConfirmation = !!addressValidation?.applicable && (addressValidation.status === "warning" || addressValidation.status === "unavailable");
      if (addressWarningNeedsConfirmation && data.addressValidationOverride?.confirmed !== true) {
        throw new Error(`ADRESSPRUEFUNG_BESTAETIGUNG_ERFORDERLICH: ${addressValidation!.warnings.map((warning) => warning.message).join(" ")}`);
      }
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
      if (data.dhlPostNumber !== undefined) updateData.dhlPostNumber = data.dhlPostNumber || null;
      if (data.communicationLanguage !== undefined) updateData.communicationLanguage = data.communicationLanguage;

      await db.update(customers).set(updateData).where(eq(customers.id, id));

      // A corrected recipient address resolves prior delivery incidents for the
      // obsolete address. Provider retries remain journalled but must not create
      // duplicate operator alerts after the correction is already completed.
      const previousEmail = existingCustomer.email?.trim().toLowerCase() || "";
      const correctedEmail = data.email?.trim().toLowerCase() || "";
      if (data.email !== undefined && previousEmail && correctedEmail && previousEmail !== correctedEmail) {
        await db.update(customerCommunications).set({
          deliveryIssueResolvedAt: new Date(),
          deliveryIssueResolution: `E-Mail-Adresse korrigiert: ${previousEmail} → ${correctedEmail}`,
          deliveryIssueResolvedBy: ctx.user.name || ctx.user.username,
        }).where(and(
          eq(customerCommunications.customerId, id),
          eq(customerCommunications.recipientEmail, previousEmail),
          inArray(customerCommunications.deliveryStatus, ["delayed", "bounced", "failed", "suppressed"]),
          sql`${customerCommunications.deliveryIssueResolvedAt} IS NULL`,
        ));
      }

      // Auftragsadressen sind vollständige historische Snapshots. Auch ein leeres
      // Firmen-/Adressfeld ist Teil dieser Adresse und darf NICHT nachträglich aus
      // einem anderen Kundenprofil nachgefüllt werden. Nur fehlende Kontaktkanäle
      // werden weiterhin ergänzt; die WHERE-Bedingung schützt Paralleländerungen.
      if (data.phone?.trim()) {
        await db.update(orders).set({ phone: data.phone }).where(and(
          eq(orders.customerId, id),
          sql`NULLIF(TRIM(${orders.phone}), '') IS NULL`,
        ));
      }
      if (data.email?.trim()) {
        await db.update(orders).set({ email: data.email }).where(and(
          eq(orders.customerId, id),
          sql`NULLIF(TRIM(${orders.email}), '') IS NULL`,
        ));
      }

      if (addressWarningNeedsConfirmation && addressValidation) {
        await persistAddressValidation({
          input: effectiveAddress,
          result: addressValidation,
          context: "customer_update",
          customerId: id,
          overrideConfirmed: true,
          confirmedBy: "Master-Admin",
        });
      }
      const identityChanged = [data.name, data.email, data.phone, data.street, data.houseNumber, data.zip, data.city, data.country]
        .some((value) => value !== undefined);
      if (identityChanged) {
        try {
          await queueCustomerDuplicateReview(id, "customer_changed", "customer.update");
        } catch (error) {
          console.warn("[Customer Integrity] Prüfung nach Kundenänderung fehlgeschlagen (nicht blockierend):", error);
        }
      }

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
          from: "369 Research <noreply@mail.369research.eu>",
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
              from: "369 Research <noreply@mail.369research.eu>",
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
  backfillFromOrders: adminProcedure
    .input(z.object({ dryRun: z.boolean().optional() }).optional())
    .mutation(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    if(!input?.dryRun)await checkCustomerCreationMaintenance('customer.backfillFromOrders','mutation',await getPool());

    const allOrders = await db.select().from(orders).orderBy(orders.orderDate);
    const existingCustomers = await db.select().from(customers);
    // Include unlinked order snapshots as candidates to detect mixed contact
    // ambiguity between historical orders as well as existing profiles.
    const candidates = [
      ...existingCustomers,
      ...allOrders.filter(order => !order.customerId).map(order => ({ ...order, id: -order.id })),
    ];
    const groups: Record<string, typeof allOrders> = {};
    const toLink: Array<{ orderId: number; customerId: number }> = [];
    let reviewOrders = 0;
    for (const order of allOrders) {
      if (order.customerId) continue;
      const resolution = resolveCheckoutCustomerDataChange(existingCustomers, order);
      if (resolution.kind === "matched") {
        toLink.push({ orderId: order.id, customerId: resolution.customer.id });
        continue;
      }
      if (resolution.kind === "conflict" || resolution.reason === "ambiguous") { reviewOrders++; continue; }
      // Creating one customer from multiple historical contact snapshots is a
      // merge decision. Keep those orders in review instead of guessing ownership.
      const acrossOrders = resolveCheckoutCustomerDataChange(candidates, order);
      if (acrossOrders.kind !== "matched" || acrossOrders.customer.id !== -order.id) { reviewOrders++; continue; }
      groups[`o:${order.orderId}`] = [order];
    }

    // Build preview
    const preview = Object.entries(groups).map(([gk, grpOrders]) => {
      const o = grpOrders[grpOrders.length - 1]; // most recent order
      return {
        groupKey: gk,
        name: `${o.firstName} ${o.lastName}`.trim(),
        email: (o.email && !!normalizeCustomerMatchEmail(o.email)) ? o.email : null,
        phone: o.phone || null,
        orderCount: grpOrders.length,
        totalSpent: grpOrders.filter(isCompletedCommercialOrder).reduce((s, x) => s + parseFloat(x.total || '0'), 0).toFixed(2),
        city: o.city || null,
        country: o.country || null,
        sampleOrderId: o.orderId,
      };
    }).filter(p => p.name.trim().length > 0);

    if (input?.dryRun) {
      return {
        success: true,
        dryRun: true,
        wouldCreate: preview.length,
        wouldLink: toLink.length,
        reviewOrders,
        preview,
        totalOrders: allOrders.length,
        created: 0,
        linked: 0,
      };
    }

    await requireCustomerNumberMigration(db);
    // Execute backfill
    let created = 0;
    let linked = 0;


    for (const [, grpOrders] of Object.entries(groups)) {
      const o = grpOrders[grpOrders.length - 1];
      const firstName = o.firstName || '';
      const lastName = o.lastName || '';
      const name = `${firstName} ${lastName}`.trim();
      if (!name) continue;

      const emailKey = (o.email || '').toLowerCase().trim();
      const emailUsable = !!normalizeCustomerMatchEmail(o.email);
      const metrics = calculateCustomerOrderMetrics(grpOrders);

      try {
        const [newCustomer] = await db.insert(customers).values({
          customerNumber: await nextCustomerNumber(db),
          name,
          firstName: firstName || null,
          lastName: lastName || null,
          phone: o.phone || null,
          email: emailUsable ? o.email : null,
          company: o.company || null,
          street: o.street || null,
          houseNumber: o.houseNumber || null,
          zip: o.zip || null,
          city: o.city || null,
          country: o.country || null,
          source: 'backfill',
          totalOrders: metrics.totalOrders,
          totalSpent: metrics.totalSpent.toFixed(2),
          firstOrderDate: metrics.firstOrderDate,
          lastOrderDate: metrics.lastOrderDate,
        }).returning();

        // Link all orders in this group to the new customer
        for (const ord of grpOrders) {
          await db.update(orders).set({ customerId: newCustomer.id }).where(eq(orders.id, ord.id));
          linked++;
        }

        created++;
      } catch (_e) { /* skip on duplicate */ }
    }

    // Link unlinked orders to existing customers
    for (const { orderId, customerId } of toLink) {
      const didLink = await db.transaction(async tx => {
        const [freshOrder] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1).for("update");
        if (!freshOrder || freshOrder.customerId) return false;
        await tx.execute(sql`LOCK TABLE customers IN SHARE MODE`);
        const fresh = resolveCheckoutCustomerDataChange(await tx.select().from(customers), freshOrder);
        if (fresh.kind !== "matched" || fresh.customer.id !== customerId) return false;
        await tx.update(orders).set({ customerId }).where(eq(orders.id, orderId));
        return true;
      });
      if (didLink) linked++; else reviewOrders++;
    }

    return { success: true, dryRun: false, created, linked, reviewOrders, totalOrders: allOrders.length, preview: [] };
  }),

  // Rebuild customer stats (totalOrders, totalSpent, firstOrderDate, lastOrderDate) from actual orders
  rebuildCustomerStats: adminProcedure.mutation(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const allCustomers = await db.select().from(customers);
    const allOrders = await db.select().from(orders);

    let updated = 0;
    for (const customer of allCustomers) {
      const uniqueOrders = allOrders.filter((order) => order.customerId === customer.id);

      const metrics = calculateCustomerOrderMetrics(uniqueOrders);
      await db.update(customers).set({
        totalOrders: metrics.totalOrders,
        totalSpent: metrics.totalSpent.toFixed(2),
        firstOrderDate: metrics.firstOrderDate,
        lastOrderDate: metrics.lastOrderDate,
        updatedAt: new Date(),
      }).where(eq(customers.id, customer.id));
      updated++;
    }
    return { success: true, updated, totalCustomers: allCustomers.length };
  }),
});
