import { integer, pgTable, text, timestamp, varchar, decimal, pgEnum, serial, jsonb, index, boolean } from "drizzle-orm/pg-core";

/**
 * Enums
 */
export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
export const stockChangeTypeEnum = pgEnum("stock_change_type", ["wareneingang", "verkauf", "korrektur", "retoure", "bestellung"]);
export const paymentMethodEnum = pgEnum("payment_method", ["bunq", "creditCard", "wise", "SEPA", "Bar", "Kreditkarte", "PayPal", "Crypto", "Guthaben", "Sonstige"]);
export const orderStatusEnum = pgEnum("order_status", ["offen", "bezahlt", "gepackt", "versendet", "zugestellt", "storniert"]);
export const commissionTypeEnum = pgEnum("commission_type", ["einmalig", "dauerhaft"]);
export const acquiredByEnum = pgEnum("acquired_by", ["shop", "partner", "direkt"]);
export const communicationTypeEnum = pgEnum("communication_type", ["email", "note", "whatsapp", "phone"]);
export const communicationStatusEnum = pgEnum("communication_status", ["sent", "failed", "draft", "logged"]);
export const emailCampaignStatusEnum = pgEnum("email_campaign_status", ["draft", "sending", "sent", "failed"]);

/**
 * Admin users table – simple JWT auth
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  role: userRoleEnum("role").default("user").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastSignedIn: timestamp("last_signed_in").defaultNow().notNull(),
  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled").default(0).notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Articles / Products – inventory management
 */
export const articles = pgTable("articles", {
  id: serial("id").primaryKey(),
  sku: varchar("sku", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  category: varchar("category", { length: 100 }),

  // Pricing
  purchasePrice: decimal("purchase_price", { precision: 10, scale: 2 }).default("0"),
  sellingPrice: decimal("selling_price", { precision: 10, scale: 2 }).default("0"),
  taxRate: decimal("tax_rate", { precision: 5, scale: 2 }).default("19"),

  // Stock
  stock: integer("stock").default(0).notNull(),
  minStock: integer("min_stock").default(5).notNull(),
  maxStock: integer("max_stock").default(100),

  // Linked to shop product (optional)
  shopProductId: varchar("shop_product_id", { length: 100 }),

  notes: text("notes"),

  // CMS: KI-generierte Beschreibung (JSON: wirkung, risiko, dosierung, quellen, fazit)
  description: jsonb("description"),
  // Artikel im Shop sichtbar?
  shopVisible: integer("shop_visible").default(0).notNull(),

  isActive: integer("is_active").default(1).notNull(),

  // Shop-Produktdaten (Single Source of Truth)
  mockupImageUrl: text("mockup_image_url"),
  labelImageUrl: text("label_image_url"),
  casNumber: varchar("cas_number", { length: 50 }),
  molecularWeight: varchar("molecular_weight", { length: 50 }),
  purity: varchar("purity", { length: 20 }),
  badge: text("badge"),
  salePrice: decimal("sale_price", { precision: 10, scale: 2 }),
  salePriceLabel: varchar("sale_price_label", { length: 100 }),
  labReportImageUrl: text("lab_report_image_url"),
  galleryImages: jsonb("gallery_images"),
  categories: jsonb("categories"),
  variants: jsonb("variants"),
  shortDescription: text("short_description"),
  beautyData: jsonb("beauty_data"),
  photoComingSoon: integer("photo_coming_soon").default(0),
  // Cross-Sell Kategorie für Follow-up Empfehlungs-Matrix
  // Werte: intake | output | regeneration | signaling | structural
    followUpCategory: varchar("follow_up_category", { length: 50 }),
  // Sprint 1: SEO/Merchant/i18n Vorbereitung (additiv)
  publishedAt: timestamp("published_at"),
  nasalSprayImageUrl: text("nasal_spray_image_url"),
  bundleDeal: jsonb("bundle_deal"),
  // Produktreihenfolge im Shop (niedrigere Zahl = weiter vorne, Default 9999)
  sortOrder: integer("sort_order").default(9999),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type Article = typeof articles.$inferSelect;
export type InsertArticle = typeof articles.$inferInsert;

/**
 * Stock history – tracks all stock changes
 */
export const stockHistory = pgTable("stock_history", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull(),

  changeType: stockChangeTypeEnum("change_type").notNull(),
  quantityBefore: integer("quantity_before").notNull(),
  quantityChange: integer("quantity_change").notNull(),
  quantityAfter: integer("quantity_after").notNull(),

  reason: text("reason"),
  orderId: varchar("order_id", { length: 32 }),
  userName: varchar("user_name", { length: 100 }),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type StockHistoryEntry = typeof stockHistory.$inferSelect;
export type InsertStockHistory = typeof stockHistory.$inferInsert;

/**
 * Customers – customer management
 */
export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  customerNumber: varchar("customer_number", { length: 20 }).unique(),
  name: varchar("name", { length: 200 }).notNull(),
  firstName: varchar("first_name", { length: 200 }),
  lastName: varchar("last_name", { length: 200 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 320 }),
  company: varchar("company", { length: 200 }),

  street: varchar("street", { length: 300 }),
  houseNumber: varchar("house_number", { length: 100 }),
  zip: varchar("zip", { length: 30 }),
  city: varchar("city", { length: 100 }),
  country: varchar("country", { length: 100 }),
  dhlPostNumber: varchar("dhl_post_number", { length: 20 }), // DHL-Postnummer für Packstation

  // CRM fields
  tags: text("tags"), // JSON array of tags, e.g. ["VIP", "Stammkunde", "B2B"]
  source: varchar("source", { length: 100 }), // e.g. "shop", "manual", "import"

  // Acquisition tracking
  acquiredBy: acquiredByEnum("acquired_by").default("shop").notNull(),
  acquiredByPartnerId: integer("acquired_by_partner_id"), // FK to partners.id

  notes: text("notes"),
  totalOrders: integer("total_orders").default(0).notNull(),
  totalSpent: decimal("total_spent", { precision: 10, scale: 2 }).default("0").notNull(),

  firstOrderDate: timestamp("first_order_date"),
  lastOrderDate: timestamp("last_order_date"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

/**
 * Customer dossier – configurable tag library plus immutable issue history.
 * Cases are resolved or archived, never deleted through the WaWi UI.
 */
export const customerTagDefinitions = pgTable("customer_tag_definitions", {
  id: serial("id").primaryKey(),
  tagKey: varchar("tag_key", { length: 80 }).notNull().unique(),
  label: varchar("label", { length: 120 }).notNull(),
  color: varchar("color", { length: 32 }).notNull().default("slate"),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(999),
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const customerIssueCases = pgTable("customer_issue_cases", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull(),
  orderId: varchar("order_id", { length: 32 }),
  category: varchar("category", { length: 64 }).notNull(),
  severity: varchar("severity", { length: 16 }).notNull().default("normal"),
  status: varchar("status", { length: 24 }).notNull().default("open"),
  title: varchar("title", { length: 240 }).notNull(),
  details: text("details").notNull(),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  createdBy: varchar("created_by", { length: 100 }).notNull(),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: varchar("resolved_by", { length: 100 }),
  resolutionNote: text("resolution_note"),
  contextSnapshotJson: text("context_snapshot_json").notNull().default("{}"),
}, (t) => ({
  customerStatusIdx: index("customer_issue_cases_customer_idx").on(t.customerId, t.status, t.occurredAt),
  orderStatusIdx: index("customer_issue_cases_order_idx").on(t.orderId, t.status, t.occurredAt),
}));
export type CustomerTagDefinition = typeof customerTagDefinitions.$inferSelect;
export type CustomerIssueCase = typeof customerIssueCases.$inferSelect;

/**
 * Immutable address-validation records. A visual evidence document is only generated
 * when a warning is consciously overridden; no UI delete path exists.
 */
export const addressValidationRecords = pgTable("address_validation_records", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id"),
  orderId: varchar("order_id", { length: 32 }),
  context: varchar("context", { length: 32 }).notNull(),
  countryCode: varchar("country_code", { length: 8 }).notNull(),
  submittedAddressJson: text("submitted_address_json").notNull(),
  providerKey: varchar("provider_key", { length: 80 }),
  providerCheckedAt: timestamp("provider_checked_at"),
  validationStatus: varchar("validation_status", { length: 32 }).notNull(),
  warningsJson: text("warnings_json").notNull().default("[]"),
  detailsJson: text("details_json").notNull().default("{}"),
  overrideConfirmed: integer("override_confirmed").notNull().default(0),
  overrideConfirmedAt: timestamp("override_confirmed_at"),
  overrideConfirmedBy: varchar("override_confirmed_by", { length: 100 }),
  evidenceSvg: text("evidence_svg"),
  evidenceSha256: varchar("evidence_sha256", { length: 128 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  customerCreatedIdx: index("address_validation_records_customer_idx").on(t.customerId, t.createdAt),
  orderCreatedIdx: index("address_validation_records_order_idx").on(t.orderId, t.createdAt),
}));
export type AddressValidationRecord = typeof addressValidationRecords.$inferSelect;

/**
 * Duplicate-check runs and findings. These are review records only: no customer,
 * order, stock, or payment data is ever changed automatically.
 */
export const duplicateCheckRuns = pgTable("duplicate_check_runs", {
  id: serial("id").primaryKey(),
  trigger: varchar("trigger", { length: 24 }).notNull(), // manual | scheduled
  status: varchar("status", { length: 24 }).notNull().default("completed"),
  customerFindings: integer("customer_findings").notNull().default(0),
  orderFindings: integer("order_findings").notNull().default(0),
  summary: text("summary"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  createdBy: varchar("created_by", { length: 100 }),
});

export const duplicateFindings = pgTable("duplicate_findings", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull(),
  entityType: varchar("entity_type", { length: 16 }).notNull(), // customer | order
  primaryRecordId: varchar("primary_record_id", { length: 64 }).notNull(),
  candidateRecordId: varchar("candidate_record_id", { length: 64 }).notNull(),
  confidence: integer("confidence").notNull(),
  reasons: text("reasons").notNull(), // JSON string; human-readable rule results
  status: varchar("status", { length: 24 }).notNull().default("open"), // open | reviewed | merged | ignored
  resolutionNote: text("resolution_note"),
  resolvedBy: varchar("resolved_by", { length: 100 }),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  runIdx: index("duplicate_findings_run_idx").on(t.runId),
  statusIdx: index("duplicate_findings_status_idx").on(t.status),
}));

export type DuplicateCheckRun = typeof duplicateCheckRuns.$inferSelect;
export type DuplicateFinding = typeof duplicateFindings.$inferSelect;

/**
 * Customer Communications – tracks all interactions with customers
 */
export const customerCommunications = pgTable("customer_communications", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull(),

  type: communicationTypeEnum("type").notNull(),
  status: communicationStatusEnum("status").notNull().default("logged"),

  subject: varchar("subject", { length: 500 }),
  body: text("body"),
  htmlBody: text("html_body"),

  // For emails
  recipientEmail: varchar("recipient_email", { length: 320 }),
  senderName: varchar("sender_name", { length: 200 }),
  senderEmail: varchar("sender_email", { length: 320 }),
  replyTo: varchar("reply_to", { length: 320 }),
  resendEmailId: varchar("resend_email_id", { length: 100 }),
  resendMessageId: varchar("resend_message_id", { length: 500 }),
  deliveryStatus: varchar("delivery_status", { length: 32 }),
  deliveryStatusAt: timestamp("delivery_status_at"),
  errorMessage: text("error_message"),
  idempotencyKey: varchar("idempotency_key", { length: 200 }),
  direction: varchar("direction", { length: 16 }).default("outbound").notNull(),
  source: varchar("source", { length: 32 }).default("manual").notNull(),

  // Reference
  orderId: varchar("order_id", { length: 32 }),
  campaignId: integer("campaign_id"),

  createdBy: varchar("created_by", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type CustomerCommunication = typeof customerCommunications.$inferSelect;
export type InsertCustomerCommunication = typeof customerCommunications.$inferInsert;

/**
 * Immutable provider event journal for customer communications.
 * Stores verified Resend webhook events and deduplicates retries by event ID.
 */
export const communicationEvents = pgTable("communication_events", {
  id: serial("id").primaryKey(),
  communicationId: integer("communication_id").notNull(),
  provider: varchar("provider", { length: 50 }).notNull().default("resend"),
  providerEventId: varchar("provider_event_id", { length: 150 }).notNull().unique(),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  occurredAt: timestamp("occurred_at").notNull(),
  payload: text("payload"),
  operatorAlertStatus: varchar("operator_alert_status", { length: 24 }),
  operatorAlertSentAt: timestamp("operator_alert_sent_at"),
  operatorAlertError: text("operator_alert_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type CommunicationEvent = typeof communicationEvents.$inferSelect;
export type InsertCommunicationEvent = typeof communicationEvents.$inferInsert;

/**
 * Email Templates – reusable HTML email templates
 */
export const emailTemplates = pgTable("email_templates", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  subject: varchar("subject", { length: 500 }).notNull(),
  htmlBody: text("html_body").notNull(),
  description: text("description"),
  isActive: integer("is_active").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type EmailTemplate = typeof emailTemplates.$inferSelect;
export type InsertEmailTemplate = typeof emailTemplates.$inferInsert;

/**
 * Communication Templates – zentrale, zweisprachige Bibliothek für E-Mail und WhatsApp.
 * Der Inhalt wird in PostgreSQL gepflegt und nicht im Frontend hartcodiert.
 */
export const communicationTemplates = pgTable("communication_templates", {
  id: serial("id").primaryKey(),
  templateKey: varchar("template_key", { length: 100 }).notNull(),
  channel: varchar("channel", { length: 20 }).notNull(),
  language: varchar("language", { length: 5 }).notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  subjectTemplate: text("subject_template"),
  bodyTemplate: text("body_template").notNull(),
  isActive: integer("is_active").default(1).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type CommunicationTemplate = typeof communicationTemplates.$inferSelect;
export type InsertCommunicationTemplate = typeof communicationTemplates.$inferInsert;

/**
 * Communication Template Audit – immutable change ledger for template maintenance.
 */
export const communicationTemplateAudit = pgTable("communication_template_audit", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull(),
  action: varchar("action", { length: 30 }).notNull(),
  previousValue: jsonb("previous_value"),
  nextValue: jsonb("next_value"),
  changedBy: varchar("changed_by", { length: 100 }).notNull().default("admin"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type CommunicationTemplateAudit = typeof communicationTemplateAudit.$inferSelect;

/**
 * Email Campaigns – bulk email sends
 */
export const emailCampaigns = pgTable("email_campaigns", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  subject: varchar("subject", { length: 500 }).notNull(),
  htmlBody: text("html_body").notNull(),
  templateId: integer("template_id"),

  status: emailCampaignStatusEnum("status").notNull().default("draft"),
  recipientCount: integer("recipient_count").default(0).notNull(),
  sentCount: integer("sent_count").default(0).notNull(),
  failedCount: integer("failed_count").default(0).notNull(),

  // Filter criteria used (JSON)
  filterCriteria: text("filter_criteria"),

  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type EmailCampaign = typeof emailCampaigns.$inferSelect;
export type InsertEmailCampaign = typeof emailCampaigns.$inferInsert;

/**
 * Orders table – stores all shop orders
 */
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderId: varchar("order_id", { length: 32 }).notNull().unique(),
  // Additive storefront metadata. Existing 369 orders retain the default and NULL values.
  storeKey: varchar("store_key", { length: 32 }).notNull().default("369research"),
  externalOrderReference: varchar("external_order_reference", { length: 32 }),
  checkoutIdempotencyKey: varchar("checkout_idempotency_key", { length: 128 }),

  // Customer info
  firstName: varchar("first_name", { length: 200 }).notNull(),
  lastName: varchar("last_name", { length: 200 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  phone: varchar("phone", { length: 50 }).notNull(),
  street: varchar("street", { length: 300 }).notNull(),
  houseNumber: varchar("house_number", { length: 100 }).notNull(),
  zip: varchar("zip", { length: 30 }).notNull(),
  city: varchar("city", { length: 100 }).notNull(),
  country: varchar("country", { length: 100 }).notNull(),
  company: varchar("company", { length: 200 }),

  // Delivery type: 'home' (default) or 'packstation'
  deliveryType: varchar("delivery_type", { length: 20 }).notNull().default("home"),
  // DHL Postnummer des Kunden (nur bei Packstation, 6-10 Ziffern)
  dhlPostNumber: varchar("dhl_post_number", { length: 20 }),

  // Link to customer record (optional)
  customerId: integer("customer_id"),

  // Financials
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }).notNull(),
  discount: decimal("discount", { precision: 10, scale: 2 }).notNull().default("0"),
  discountCode: varchar("discount_code", { length: 50 }),
  /** Strukturierte, additive Herkunft aller Preisnachlässe für WaWi und Audit. */
  discountBreakdown: jsonb("discount_breakdown").$type<Array<{
    source: string;
    label: string;
    amount: number;
    percentage?: number;
    code?: string;
  }>>(),
  shipping: decimal("shipping", { precision: 10, scale: 2 }).notNull(),
  shippingCountry: varchar("shipping_country", { length: 10 }).notNull(),
  total: decimal("total", { precision: 10, scale: 2 }).notNull(),

  // Payment
  paymentMethod: paymentMethodEnum("payment_method").notNull(),

  // Status workflow
  status: orderStatusEnum("status").default("offen").notNull(),

  // Tracking
  trackingNumber: varchar("tracking_number", { length: 100 }),
  trackingCarrier: varchar("tracking_carrier", { length: 50 }),

  // Shipping label: URL = interne Download-Route, Content = Base64-PDF persistent in DB
  shippingLabelUrl: text("shipping_label_url"),
  shippingLabelContent: text("shipping_label_content"),

  // Pack-Foto: Pflichtfoto beim Packvorgang, dauerhaft in DB gespeichert
  packingPhotoUrl: text("packing_photo_url"),
  packingPhotoAt: timestamp("packing_photo_at"),
  // Versandgewicht in Gramm (für DHL-Label, optional – Default 500g wenn leer)
  weightGrams: integer("weight_grams"),

  // Partner / Affiliate
  partnerCode: varchar("partner_code", { length: 50 }),
  partnerNumber: varchar("partner_number", { length: 50 }),
  partnerDiscount: decimal("partner_discount", { precision: 10, scale: 2 }).default("0"),
  partnerCommission: decimal("partner_commission", { precision: 10, scale: 2 }).default("0"),
  creditUsed: decimal("credit_used", { precision: 10, scale: 2 }).default("0"),
  kwkCreditUsed: decimal("kwk_credit_used", { precision: 10, scale: 2 }).default("0"),
  kwkCreditRequested: decimal("kwk_credit_requested", { precision: 10, scale: 2 }).default("0"),

  // First-party marketing QR attribution. Product/serial QR codes under `/i/*`
  // use a separate namespace and are never written into these campaign fields.
  qrCampaignId: integer("qr_campaign_id"),
  qrAttributionToken: varchar("qr_attribution_token", { length: 64 }),
  qrCode: varchar("qr_code", { length: 100 }),
  qrCampaignName: varchar("qr_campaign_name", { length: 160 }),
  qrCampaignMedium: varchar("qr_campaign_medium", { length: 100 }),
  qrCampaignLocation: varchar("qr_campaign_location", { length: 200 }),

  // Bunq payment matching
  bunqPaymentId: varchar("bunq_payment_id", { length: 100 }),
  bunqMatchedAt: timestamp("bunq_matched_at"),

  // Notes
  internalNote: text("internal_note"),

  // Timestamps
  orderDate: timestamp("order_date").notNull(),
  paidAt: timestamp("paid_at"),
  packedAt: timestamp("packed_at"),
  shippedAt: timestamp("shipped_at"),
  deliveredAt: timestamp("delivered_at"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  statusIdx: index("orders_status_idx").on(t.status),
  orderDateIdx: index("orders_order_date_idx").on(t.orderDate),
  customerIdIdx: index("orders_customer_id_idx").on(t.customerId),
  emailIdx: index("orders_email_idx").on(t.email),
  qrCampaignIdx: index("orders_qr_campaign_idx").on(t.qrCampaignId, t.orderDate),
  qrAttributionIdx: index("orders_qr_attribution_idx").on(t.qrAttributionToken),
}));

export type Order = typeof orders.$inferSelect;
export type InsertOrder = typeof orders.$inferInsert;

/**
 * Order items – individual line items per order
 */
export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: varchar("order_id", { length: 32 }).notNull(),

  name: varchar("name", { length: 200 }).notNull(),
  dosage: varchar("dosage", { length: 50 }),
  variant: varchar("variant", { length: 100 }),
  type: varchar("type", { length: 50 }).notNull(),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  quantity: integer("quantity").notNull(),

  // Link to article for stock management
  articleId: integer("article_id"),

  // Nasenspray- und Plug&Play-Flags (additiv, für WaWi-Anzeige)
  isNasalSpray: boolean("is_nasal_spray").notNull().default(false),
  // Optionales DIY-Set: Vial plus Komponenten, aber kein fertig gemischtes Nasenspray.
  isNasalDiySet: boolean("is_nasal_diy_set").notNull().default(false),
  isPlugPlay: boolean("is_plug_play").notNull().default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type OrderItem = typeof orderItems.$inferSelect;
export type InsertOrderItem = typeof orderItems.$inferInsert;

/**
 * Partners / Affiliates – partner management
 * Each partner has:
 * - A unique code (e.g. "ALEX10") that customers enter at checkout for a discount
 * - A unique partner number (e.g. "P-1001") that the partner uses to redeem credit
 * - A configurable customer discount % (only on product subtotal, not shipping)
 * - A configurable commission % (on the discounted product subtotal)
 * - A running credit balance from earned commissions
 */
export const partners = pgTable("partners", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 50 }),
  company: varchar("company", { length: 200 }),

  // Unique affiliate code (entered by customers at checkout)
  code: varchar("code", { length: 50 }).notNull().unique(),

  // Unique partner number (used by partner to redeem credit)
  partnerNumber: varchar("partner_number", { length: 50 }).notNull().unique(),

  // Commission: % the partner earns on discounted product subtotal
  commissionPercent: decimal("commission_percent", { precision: 5, scale: 2 }).notNull().default("10"),

  // Customer discount: % discount for customers using this partner's code (only on products, not shipping)
  customerDiscountPercent: decimal("customer_discount_percent", { precision: 5, scale: 2 }).notNull().default("10"),

  // Running credit balance (sum of all commissions minus redemptions)
  creditBalance: decimal("credit_balance", { precision: 10, scale: 2 }).notNull().default("0"),

  // Commission type: einmalig = one-time cash payout, dauerhaft = ongoing shop credit
  commissionType: commissionTypeEnum("commission_type").default("dauerhaft").notNull(),

  // Partner login credentials
  passwordHash: text("password_hash"),
  lastLogin: timestamp("last_login"),

  // Active flag
  isActive: integer("is_active").default(1).notNull(),

  // Delivery address (used when partner orders via Partner-ID)
  street: varchar("street", { length: 300 }),
  houseNumber: varchar("house_number", { length: 100 }),
  zip: varchar("zip", { length: 30 }),
  city: varchar("city", { length: 100 }),
  country: varchar("country", { length: 100 }),

  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Partner = typeof partners.$inferSelect;
export type InsertPartner = typeof partners.$inferInsert;

/**
 * Partner transactions – tracks all credit movements
 * Types:
 * - "provision"  → commission earned from a referred order
 * - "einloesung" → credit redeemed at checkout by the partner
 * - "korrektur"  → manual adjustment by admin
 */
export const partnerTransactionTypeEnum = pgEnum("partner_transaction_type", ["provision", "einloesung", "korrektur", "auszahlung"]);
export const transactionStatusEnum = pgEnum("transaction_status", ["normal", "storniert", "nicht_gewertet", "ausgeblendet"]);

export const partnerTransactions = pgTable("partner_transactions", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull(),

  type: partnerTransactionTypeEnum("type").notNull(),

  // Amount (positive for provision/korrektur+, negative for einloesung/korrektur-)
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),

  // Balance after this transaction
  balanceAfter: decimal("balance_after", { precision: 10, scale: 2 }).notNull(),

  // Reference to order (if applicable)
  orderId: varchar("order_id", { length: 32 }),

  // Customer name (for provision tracking)
  customerName: varchar("customer_name", { length: 200 }),

  // Description
  description: text("description"),

  // Transaction status for admin control
  status: transactionStatusEnum("status").default("normal").notNull(),

  // Admin note for documenting status changes
  adminNote: text("admin_note"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PartnerTransaction = typeof partnerTransactions.$inferSelect;
export type InsertPartnerTransaction = typeof partnerTransactions.$inferInsert;

/**
 * Order-specific partner credit overrides – optional explicit amount for a single order.
 * The override is only evaluated after a confirmed payment and remains fully auditable.
 */
export const partnerOrderCreditOverrides = pgTable("partner_order_credit_overrides", {
  id: serial("id").primaryKey(),
  orderId: varchar("order_id", { length: 32 }).notNull().unique(),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  reason: text("reason").notNull(),
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PartnerOrderCreditOverride = typeof partnerOrderCreditOverrides.$inferSelect;
export type InsertPartnerOrderCreditOverride = typeof partnerOrderCreditOverrides.$inferInsert;

/**
 * Promo Codes – time-limited discount codes managed in WaWi
 * Unlike partner codes, these can be used by any customer (including returning ones)
 * They have optional expiry dates and usage limits
 */
export const promoCodeDiscountTypeEnum = pgEnum("promo_code_discount_type", ["percent", "fixed"]);

export const promoCodes = pgTable("promo_codes", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  
  // Discount
  discountType: promoCodeDiscountTypeEnum("discount_type").notNull().default("percent"),
  percentage: decimal("percentage", { precision: 5, scale: 2 }).default("0"),
  fixedAmount: decimal("fixed_amount", { precision: 10, scale: 2 }).default("0"),
  
  // Constraints
  minOrder: decimal("min_order", { precision: 10, scale: 2 }).default("0"),
  maxUses: integer("max_uses").default(0), // 0 = unlimited
  currentUses: integer("current_uses").default(0).notNull(),
  
  // Validity period
  validFrom: timestamp("valid_from"),
  validUntil: timestamp("valid_until"),
  
  // Status
  isActive: integer("is_active").default(1).notNull(),
  
  // Meta
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PromoCode = typeof promoCodes.$inferSelect;
export type InsertPromoCode = typeof promoCodes.$inferInsert;

/**
 * Partner code usage – tracks which emails have used a partner code
 * Each email can only use a partner code ONCE (first purchase only)
 */
export const partnerCodeUsage = pgTable("partner_code_usage", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  partnerCode: varchar("partner_code", { length: 50 }).notNull(),
  orderId: varchar("order_id", { length: 32 }).notNull(),
  usedAt: timestamp("used_at").defaultNow().notNull(),
});

export type PartnerCodeUsage = typeof partnerCodeUsage.$inferSelect;
export type InsertPartnerCodeUsage = typeof partnerCodeUsage.$inferInsert;

/**
 * Shop Settings – key/value store for global shop configuration
 * e.g. shop_open = true/false (Master Out-of-Stock toggle)
 */
export const shopSettings = pgTable("shop_settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ShopSetting = typeof shopSettings.$inferSelect;
export type InsertShopSetting = typeof shopSettings.$inferInsert;

/**
 * Invoices – persistent invoice storage (replaces browser localStorage)
 * Each row stores a generated invoice with its full HTML for rendering/printing.
 */
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: varchar("invoice_number", { length: 50 }).notNull().unique(),
  orderNumber: varchar("order_number", { length: 32 }).notNull(),

  date: varchar("date", { length: 10 }).notNull(),      // dd.mm.yyyy
  dateISO: varchar("date_iso", { length: 10 }).notNull(), // yyyy-mm-dd

  totalGross: decimal("total_gross", { precision: 10, scale: 2 }).notNull(),
  html: text("html").notNull(),

  // Line items summary (JSON)
  items: text("items").notNull().default("[]"),

  splitIndex: integer("split_index"),
  splitTotal: integer("split_total"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = typeof invoices.$inferInsert;

/**
 * Purchase Orders (Wareneingänge) – stored in DB for persistence across devices
 * Replaces the previous localStorage-based system
 */
export const purchaseOrderStatusEnum = pgEnum("purchase_order_status", [
  "bestellt",
  "versendet",
  "teilweise_eingetroffen",
  "vollständig",
  "abgeschlossen",
]);

export const purchaseOrders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  poNumber: varchar("po_number", { length: 50 }).notNull().unique(), // e.g. "PO-2026-001"

  supplierName: varchar("supplier_name", { length: 200 }).notNull(),
  orderDate: timestamp("order_date").notNull(),
  shippingDate: timestamp("shipping_date"),
  receivedDate: timestamp("received_date"),
  trackingNumber: varchar("tracking_number", { length: 100 }),

  status: purchaseOrderStatusEnum("status").notNull().default("bestellt"),

  // Financials
  shippingCostUsd: decimal("shipping_cost_usd", { precision: 10, scale: 2 }),
  totalUsd: decimal("total_usd", { precision: 10, scale: 2 }),
  usdToEurRate: decimal("usd_to_eur_rate", { precision: 8, scale: 4 }),

  notes: text("notes"),

  // Original screenshot stored as reference (base64 or URL)
  screenshotRef: text("screenshot_ref"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type InsertPurchaseOrder = typeof purchaseOrders.$inferInsert;

/**
 * Purchase Order Items – line items per purchase order
 */
export const purchaseOrderItems = pgTable("purchase_order_items", {
  id: serial("id").primaryKey(),
  purchaseOrderId: integer("purchase_order_id").notNull(), // FK to purchaseOrders.id

  // Article link
  articleId: integer("article_id"),                        // FK to articles.id (nullable if new)
  sku: varchar("sku", { length: 50 }),
  name: varchar("name", { length: 200 }).notNull(),
  dosage: varchar("dosage", { length: 50 }),
  supplierCode: varchar("supplier_code", { length: 100 }), // Händler-Kürzel

  // Quantities
  orderedQty: integer("ordered_qty").notNull().default(0),
  receivedQty: integer("received_qty").notNull().default(0),
  packQuantity: integer("pack_quantity"),
  packSize: integer("pack_size"),

  // Pricing
  purchasePriceEur: decimal("purchase_price_eur", { precision: 10, scale: 4 }),
  priceUsd: decimal("price_usd", { precision: 10, scale: 2 }),
  shippingMarkup: decimal("shipping_markup", { precision: 5, scale: 4 }),
  usdToEurRate: decimal("usd_to_eur_rate", { precision: 8, scale: 4 }),
  sellingPrice: decimal("selling_price", { precision: 10, scale: 2 }),

  // Batch number assigned at goods receipt – editable by user
  batchNumber: varchar("batch_number", { length: 100 }),

  receivedAt: timestamp("received_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PurchaseOrderItem = typeof purchaseOrderItems.$inferSelect;
export type InsertPurchaseOrderItem = typeof purchaseOrderItems.$inferInsert;

/**
 * Batches – all available batches per article
 * Created when goods are received (Wareneingang) and a batch number is assigned.
 * Used to track which batch a customer received.
 */
export const batches = pgTable("batches", {
  id: serial("id").primaryKey(),
  batchNumber: varchar("batch_number", { length: 100 }).notNull(),

  // Linked article
  articleId: integer("article_id").notNull(),              // FK to articles.id
  articleName: varchar("article_name", { length: 200 }).notNull(),

  // Source
  purchaseOrderId: integer("purchase_order_id"),           // FK to purchaseOrders.id
  purchaseOrderItemId: integer("purchase_order_item_id"),  // FK to purchaseOrderItems.id
  supplierName: varchar("supplier_name", { length: 200 }),

  // Quantity in this batch
  quantity: integer("quantity").notNull().default(0),
  remainingQty: integer("remaining_qty").notNull().default(0),

  receivedDate: timestamp("received_date"),
  notes: text("notes"),

  isActive: integer("is_active").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Batch = typeof batches.$inferSelect;
export type InsertBatch = typeof batches.$inferInsert;

/**
 * Order Item Batches – which batch was used for which order item
 * INTERNAL ONLY – never shown to customers, not in invoices, not in emails
 */
export const orderItemBatches = pgTable("order_item_batches", {
  id: serial("id").primaryKey(),

  // Order reference
  orderId: varchar("order_id", { length: 32 }).notNull(),  // FK to orders.orderId
  orderItemId: integer("order_item_id"),                   // FK to orderItems.id (optional)

  // Article
  articleId: integer("article_id"),
  articleName: varchar("article_name", { length: 200 }).notNull(),

  // Batch assigned
  batchId: integer("batch_id"),                            // FK to batches.id
  batchNumber: varchar("batch_number", { length: 100 }).notNull(),

  // Quantity from this batch used in this order
  quantity: integer("quantity").notNull().default(1),

  // Who assigned it and when
  assignedBy: varchar("assigned_by", { length: 100 }),
  assignedAt: timestamp("assigned_at").defaultNow().notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type OrderItemBatch = typeof orderItemBatches.$inferSelect;
export type InsertOrderItemBatch = typeof orderItemBatches.$inferInsert;

/**
 * Sales Follow-ups – 7-Tage-Follow-up nach Versand für Cross-Sell
 * Trigger: order.status = "versendet" AND shipped_at + 7 Tage erreicht
 * Nur Referenzen auf bestehende Tabellen, KEINE Duplikate von Kunden-/Bestelldaten
 */
export const followUpStatusEnum = pgEnum("follow_up_status", ["pending", "done", "skipped"]);

export const salesFollowups = pgTable("sales_followups", {
  id: serial("id").primaryKey(),
  // Reference to the triggering order (FK to orders.orderId)
  orderId: varchar("order_id", { length: 32 }).notNull().unique(), // 1 Follow-up per order max
  // Status
  status: followUpStatusEnum("status").notNull().default("pending"),
  // When the follow-up is due (shipped_at + 7 days)
  dueAt: timestamp("due_at").notNull(),
  // Completion tracking
  completedAt: timestamp("completed_at"),
  skippedAt: timestamp("skipped_at"),
  completedBy: varchar("completed_by", { length: 100 }),
  // Generated message content (stored for audit trail)
  whatsappMessage: text("whatsapp_message"),
  emailSubject: varchar("email_subject", { length: 300 }),
  emailBody: text("email_body"),
  // Email send tracking
  emailSentAt: timestamp("email_sent_at"),
  emailSentTo: varchar("email_sent_to", { length: 320 }),
  // Individual promo code (AGAIN-[ORDERNR]-[4CHARS])
  promoCodeId: integer("promo_code_id"),
  discountCode: varchar("discount_code", { length: 50 }),
  codeCreatedAt: timestamp("code_created_at"),
  codeExpiresAt: timestamp("code_expires_at"),
  messageGeneratedAt: timestamp("message_generated_at"),
  whatsappOpenedAt: timestamp("whatsapp_opened_at"),
  // Reminder stage (1 = first, 2 = second, etc. – for future multi-stage support)
  reminderStage: integer("reminder_stage").default(1).notNull(),
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type SalesFollowup = typeof salesFollowups.$inferSelect;
export type InsertSalesFollowup = typeof salesFollowups.$inferInsert;

/**
 * Sales Follow-up Products – selected cross-sell products per follow-up
 * References articles table only, no product data duplication
 */
export const salesFollowupProducts = pgTable("sales_followup_products", {
  id: serial("id").primaryKey(),
  followupId: integer("followup_id").notNull(), // FK to salesFollowups.id
  articleId: integer("article_id").notNull(),   // FK to articles.id
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type SalesFollowupProduct = typeof salesFollowupProducts.$inferSelect;
export type InsertSalesFollowupProduct = typeof salesFollowupProducts.$inferInsert;

// ============================================================
// SPRINT 1: MEHRSPRACHIGKEIT, SEO, MERCHANT CENTER
// Datum: 2026-06-14 | Rein additiv – keine bestehenden Felder geändert
// ============================================================

/**
 * article_translations – Mehrsprachige Produkttexte
 * Fallback-Regel: Wenn Übersetzung fehlt, immer DE verwenden.
 * UNIQUE(articleId, lang) – keine doppelten Einträge pro Sprache
 */
export const articleTranslations = pgTable("article_translations", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  lang: varchar("lang", { length: 5 }).notNull(),
  name: varchar("name", { length: 200 }),
  shortDescription: text("short_description"),
  description: jsonb("description"),
  seoTitle: varchar("seo_title", { length: 70 }),
  seoDescription: varchar("seo_description", { length: 160 }),
  merchantTitle: varchar("merchant_title", { length: 150 }),
  merchantDescription: text("merchant_description"),
  imageAlt: varchar("image_alt", { length: 200 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ArticleTranslation = typeof articleTranslations.$inferSelect;
export type InsertArticleTranslation = typeof articleTranslations.$inferInsert;

/**
 * article_seo – SEO-Konfiguration pro Produkt (1:1 zu articles)
 * Slugs sind dauerhaft stabil – niemals ohne 301-Redirect ändern.
 */
export const articleSeo = pgTable("article_seo", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  slug: varchar("slug", { length: 200 }).notNull().unique(),
  // Sprint 2: SEO-Texte und hreflang (additiv)
  seoTitle: varchar("seo_title", { length: 70 }),
  seoDescription: varchar("seo_description", { length: 160 }),
  imageAlt: varchar("image_alt", { length: 200 }),
  hreflang: text("hreflang"),
  canonical: text("canonical"),
  robots: varchar("robots", { length: 50 }).default("index,follow"),
  schemaEnabled: integer("schema_enabled").default(1),
  faqEnabled: integer("faq_enabled").default(0),
  ogImage: text("og_image"),
  priority: decimal("priority", { precision: 2, scale: 1 }).default("0.8"),
  changefreq: varchar("changefreq", { length: 20 }).default("weekly"),
  // Sprint 3: seoKeywords (additiv)
  seoKeywords: varchar("seo_keywords", { length: 500 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ArticleSeo = typeof articleSeo.$inferSelect;
export type InsertArticleSeo = typeof articleSeo.$inferInsert;

/**
 * article_merchant – Google Merchant Center Daten (1:1 zu articles)
 * availability = Override für Sonderfälle; Feed berechnet dynamisch aus articles.stock
 */
export const articleMerchant = pgTable("article_merchant", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  googleProductCategory: varchar("google_product_category", { length: 10 }),
  // Sprint 2: brand (additiv)
  brand: varchar("brand", { length: 100 }).default("369 Research"),
  productType: varchar("product_type", { length: 200 }),
  gtin: varchar("gtin", { length: 14 }),
  mpn: varchar("mpn", { length: 70 }),
  availability: varchar("availability", { length: 20 }).default("in_stock"),
  shippingLabel: varchar("shipping_label", { length: 50 }),
  condition: varchar("condition", { length: 10 }).default("new"),
  ageGroup: varchar("age_group", { length: 20 }).default("adult"),
  customLabel0: varchar("custom_label_0", { length: 100 }),
  customLabel1: varchar("custom_label_1", { length: 100 }),
  customLabel2: varchar("custom_label_2", { length: 100 }),
  // Sprint 3: merchantTitle + merchantDescription (additiv)
  merchantTitle: varchar("merchant_title", { length: 150 }),
  merchantDescription: text("merchant_description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ArticleMerchant = typeof articleMerchant.$inferSelect;
export type InsertArticleMerchant = typeof articleMerchant.$inferInsert;

/**
 * categories – Kategorie-/Landingpage-Struktur
 * Redesign-sicher: Kategorien frei änderbar ohne Produkte oder Orders zu berühren.
 */
export const shopCategories = pgTable("categories", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 200 }).notNull().unique(),
  parentId: integer("parent_id"),
  imageUrl: text("image_url"),
  sortOrder: integer("sort_order").default(0),
  visible: integer("visible").default(1),
  type: varchar("type", { length: 50 }).default("shop"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ShopCategory = typeof shopCategories.$inferSelect;
export type InsertShopCategory = typeof shopCategories.$inferInsert;

/**
 * category_translations – Mehrsprachige Kategorie-Texte und SEO-Daten
 * UNIQUE(categoryId, lang) – keine doppelten Einträge pro Sprache
 */
export const categoryTranslations = pgTable("category_translations", {
  id: serial("id").primaryKey(),
  categoryId: integer("category_id").notNull().references(() => shopCategories.id, { onDelete: "cascade" }),
  lang: varchar("lang", { length: 5 }).notNull(),
  name: varchar("name", { length: 200 }),
  description: text("description"),
  seoTitle: varchar("seo_title", { length: 70 }),
  seoDescription: varchar("seo_description", { length: 160 }),
  imageAlt: varchar("image_alt", { length: 200 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type CategoryTranslation = typeof categoryTranslations.$inferSelect;
export type InsertCategoryTranslation = typeof categoryTranslations.$inferInsert;

// ============================================================
// SPRINT 4: KNOWLEDGE LAYER – Use Cases, FAQ, Studies, Bundles, Tags
// Datum: 2026-06-14 | Rein additiv – keine bestehenden Felder geändert
// ZERO RISK: Keine Änderungen an orders, articles (Kern), customers, WaWi
// ============================================================

/**
 * use_cases – Anwendungsfall-Landingpages (z.B. "fat-loss", "anti-aging", "sleep")
 * Jeder Use Case bekommt eine eigene SEO-Landingpage unter /de/fat-loss etc.
 * featured_article_id: Welches Produkt wird als Hauptprodukt auf der Landingpage gezeigt
 */
export const useCases = pgTable("use_cases", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 200 }).notNull().unique(), // z.B. "fat-loss", "anti-aging"
  featuredArticleId: integer("featured_article_id"),         // FK zu articles.id (optional)
  imageUrl: text("image_url"),
  sortOrder: integer("sort_order").default(0),
  visible: integer("visible").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type UseCase = typeof useCases.$inferSelect;
export type InsertUseCase = typeof useCases.$inferInsert;

/**
 * use_case_translations – Mehrsprachige Use-Case-Texte und SEO-Daten
 * UNIQUE(useCaseId, lang) – keine doppelten Einträge pro Sprache
 */
export const useCaseTranslations = pgTable("use_case_translations", {
  id: serial("id").primaryKey(),
  useCaseId: integer("use_case_id").notNull().references(() => useCases.id, { onDelete: "cascade" }),
  lang: varchar("lang", { length: 5 }).notNull(), // z.B. "de", "en", "fr"
  name: varchar("name", { length: 200 }),           // z.B. "Fettabbau", "Fat Loss"
  description: text("description"),
  seoTitle: varchar("seo_title", { length: 70 }),
  seoDescription: varchar("seo_description", { length: 160 }),
  imageAlt: varchar("image_alt", { length: 200 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type UseCaseTranslation = typeof useCaseTranslations.$inferSelect;
export type InsertUseCaseTranslation = typeof useCaseTranslations.$inferInsert;

/**
 * article_use_cases – N:M Verknüpfung Artikel ↔ Use Cases
 * sort_order: Reihenfolge der Produkte auf der Use-Case-Landingpage
 * is_primary: Ist dieses Produkt das Hauptprodukt für diesen Use Case?
 */
export const articleUseCases = pgTable("article_use_cases", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  useCaseId: integer("use_case_id").notNull().references(() => useCases.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").default(0),
  isPrimary: integer("is_primary").default(0), // 1 = Hauptprodukt für diesen Use Case
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type ArticleUseCase = typeof articleUseCases.$inferSelect;
export type InsertArticleUseCase = typeof articleUseCases.$inferInsert;

/**
 * article_tags – Flexible Tag-Struktur für Produkte
 * Ermöglicht: Filterung, Cross-Sell-Matrix, PepGPT-Kontext, TikTok-Content-Planung
 * Beispiele: "glp-1", "longevity", "anti-aging", "skin", "performance", "sleep"
 */
export const articleTags = pgTable("article_tags", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  tag: varchar("tag", { length: 100 }).notNull(),
  source: varchar("source", { length: 50 }).default("manual"), // "manual" | "ai" | "import"
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type ArticleTag = typeof articleTags.$inferSelect;
export type InsertArticleTag = typeof articleTags.$inferInsert;

/**
 * article_faq – FAQ-Einträge pro Produkt (für Schema.org FAQPage + Rich Results)
 * Mehrsprachig via lang-Feld. Google zeigt FAQs direkt in den Suchergebnissen.
 * WICHTIG: Keine medizinischen Aussagen – immer "Research Use Only" Framing
 */
export const articleFaq = pgTable("article_faq", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  lang: varchar("lang", { length: 5 }).notNull().default("de"),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  sortOrder: integer("sort_order").default(0),
  isVisible: integer("is_visible").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ArticleFaq = typeof articleFaq.$inferSelect;
export type InsertArticleFaq = typeof articleFaq.$inferInsert;

/**
 * article_studies – PubMed/DOI-Studienreferenzen pro Produkt
 * Für: Academy-Content, PepGPT-Kontext, Produktseiten-Quellenangaben
 * Stärkt E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness)
 */
export const articleStudies = pgTable("article_studies", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  pubmedId: varchar("pubmed_id", { length: 20 }),   // z.B. "12345678"
  doi: varchar("doi", { length: 200 }),              // z.B. "10.1016/j.peptides.2020.01.001"
  title: text("title").notNull(),
  authors: text("authors"),
  journal: varchar("journal", { length: 200 }),
  year: integer("year"),
  url: text("url"),                                  // Direktlink zur Studie
  summary: text("summary"),                          // Kurzzusammenfassung (DE oder EN)
  relevance: varchar("relevance", { length: 50 }),   // "primary" | "supporting" | "context"
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ArticleStudy = typeof articleStudies.$inferSelect;
export type InsertArticleStudy = typeof articleStudies.$inferInsert;

/**
 * article_bundles – Bundle-Definitionen für Cross-Sell und Forscher-Bundles
 * Ermöglicht: "Stack"-Logik, Bundle-Preise, Forscher-Bundle-Kategorie
 * bundle_type: "stack" = Empfohlene Kombination, "kit" = Starter-Kit, "custom" = Sonderangebot
 */
export const bundleTypeEnum = pgEnum("bundle_type", ["stack", "kit", "custom"]);

export const articleBundles = pgTable("article_bundles", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 200 }).notNull().unique(), // z.B. "fat-loss-stack"
  bundleType: bundleTypeEnum("bundle_type").notNull().default("stack"),
  name: varchar("name", { length: 200 }).notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  // Preis-Override (optional – wenn leer, wird Summe der Einzelpreise berechnet)
  bundlePrice: decimal("bundle_price", { precision: 10, scale: 2 }),
  discountPercent: decimal("discount_percent", { precision: 5, scale: 2 }).default("0"),
  sortOrder: integer("sort_order").default(0),
  isVisible: integer("is_visible").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ArticleBundle = typeof articleBundles.$inferSelect;
export type InsertArticleBundle = typeof articleBundles.$inferInsert;

/**
 * article_bundle_items – Artikel in einem Bundle (N:M)
 * quantity: Wie viele Einheiten dieses Artikels im Bundle enthalten sind
 */
export const articleBundleItems = pgTable("article_bundle_items", {
  id: serial("id").primaryKey(),
  bundleId: integer("bundle_id").notNull().references(() => articleBundles.id, { onDelete: "cascade" }),
  articleId: integer("article_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull().default(1),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type ArticleBundleItem = typeof articleBundleItems.$inferSelect;
export type InsertArticleBundleItem = typeof articleBundleItems.$inferInsert;

/**
 * article_comparisons – Vergleichstabellen für Produktseiten und SEO
 * Ermöglicht: "Retatrutide vs. Tirzepatide" Seiten (hohe SEO-Relevanz)
 * Diese Seiten ranken extrem gut für "Peptid A vs Peptid B" Suchanfragen
 */
export const articleComparisons = pgTable("article_comparisons", {
  id: serial("id").primaryKey(),
  articleAId: integer("article_a_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  articleBId: integer("article_b_id").notNull().references(() => articles.id, { onDelete: "cascade" }),
  slug: varchar("slug", { length: 200 }).notNull().unique(), // z.B. "retatrutide-vs-tirzepatide"
  comparisonData: jsonb("comparison_data"),                  // Strukturierter Vergleich als JSON
  isVisible: integer("is_visible").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
export type ArticleComparison = typeof articleComparisons.$inferSelect;
export type InsertArticleComparison = typeof articleComparisons.$inferInsert;

// ============================================================
// SPRINT 5: SEO CONTENT ENGINE – Schema-Erweiterungen
// Datum: 2026-06-14 | Rein additiv – ALTER TABLE only
// ZERO RISK: Keine Änderungen an bestehenden Feldern
// ============================================================

/**
 * Sprint 5 Erweiterungen – werden als ALTER TABLE in Migration 0013 umgesetzt
 *
 * use_cases: + icon (Emoji/Icon-Name für Landingpage-Hero), + is_active (Alias für visible, expliziter)
 * use_case_translations: + title (SEO-H1, getrennt von name), + hero_text (kurzer Hero-Subtext)
 * article_faq: + schema_enabled (0/1 – ob dieser FAQ in Schema.org FAQPage erscheint)
 * article_studies: + study_type (RCT/observational/in-vitro/in-vivo/meta-analysis/case-report)
 *                  + population (z.B. "human", "rat", "in-vitro", "mixed")
 *                  + keywords (JSON-Array für PepGPT-Kontext und Filterung)
 * article_merchant: + sale_price (Aktionspreis, optional)
 *                   + sale_price_effective_date (ISO 8601 Zeitraum, optional)
 *                   + shipping (JSON: {country, service, price} für Feed)
 *                   + identifier_exists (yes/no – für Produkte ohne GTIN)
 *                   + merchant_title (DE-Titel für Feed, überschreibt articles.name)
 *                   + merchant_description (DE-Beschreibung für Feed)
 *                   + canonical_url (kanonische URL für Feed-Link)
 *                   + image_link (Haupt-Bild-URL für Feed, überschreibt mockup_image_url)
 *                   + alt_image_link (Zusatz-Bild-URL für Feed)
 *                   + price_override (Preis-Override für Feed, wenn leer → articles.selling_price)
 *                   + currency (ISO 4217, default "EUR")
 *
 * HINWEIS: Diese Felder sind in schema.ts als Kommentar dokumentiert.
 * Die eigentlichen ALTER TABLE Statements stehen in Migration 0013.
 * Drizzle kann ALTER TABLE nicht direkt aus schema.ts ableiten wenn die Tabelle bereits existiert –
 * daher werden die Felder in der Migration manuell definiert.
 */

// Keine neuen pgTable-Definitionen hier – nur ALTER TABLE in 0013_sprint5_schema_extensions.sql
// Die TypeScript-Typen werden nach Anwendung der Migration durch Drizzle-Introspection aktualisiert.

// ============================================================
// PRODUCT MANAGER API – Sprint PM
// Datum: 2026-06-16 | Rein additiv – keine bestehenden Felder geändert
// ZERO RISK: Keine Änderungen an orders, customers, invoices, WaWi-Logik
// ============================================================

/**
 * product_audit_log – Vollständiges Audit-Trail für Produktänderungen
 * Jede Änderung über die Product Manager API wird hier protokolliert.
 * rollback_data enthält einen vollständigen Snapshot des Artikels vor der Änderung.
 * WICHTIG: Rollback betrifft NUR Produktdaten (articles, article_seo, article_merchant, article_translations).
 * Niemals: orders, customers, invoices, payments, stock_history, users, migrations.
 */
export const productAuditLog = pgTable("product_audit_log", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => articles.id),
  action: varchar("action", { length: 50 }).notNull(),
  // 'create' | 'update' | 'price_change' | 'seo_update' | 'merchant_update'
  // 'image_update' | 'publish' | 'archive' | 'stock_change' | 'rollback'
  fieldName: varchar("field_name", { length: 100 }),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedBy: varchar("changed_by", { length: 100 }).notNull(),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
  rollbackData: jsonb("rollback_data"),
  // Snapshot: { article, seo, merchant } – für Rollback verwendet
});

export type ProductAuditLog = typeof productAuditLog.$inferSelect;
export type InsertProductAuditLog = typeof productAuditLog.$inferInsert;

// NOTE: userRoleEnum muss auf ["user", "admin", "product_manager"] erweitert werden.
// Da PostgreSQL-ENUMs nicht einfach via ALTER TYPE in allen Versionen idempotent sind,
// wird die Erweiterung in Migration 0014 als:
//   ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'product_manager';
// umgesetzt. Die TypeScript-Typen werden nach der Migration aktualisiert.

// ============================================================
// FORSCHER-BUNDLES – Sprint Bundles 2026-06
// Datum: 2026-06-20 | Rein additiv – keine bestehenden Felder geändert
// ============================================================
export const bundles = pgTable('bundles', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 200 }).notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  tagline: text('tagline'),
  description: text('description'),
  discountPercent: decimal('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  allowsPlugPlay: integer('allows_plug_play').notNull().default(0),
  allowsNasalSpray: integer('allows_nasal_spray').notNull().default(0),
  imageUrl: text('image_url'),
  isActive: integer('is_active').notNull().default(1),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
export type Bundle = typeof bundles.$inferSelect;
export type InsertBundle = typeof bundles.$inferInsert;

export const bundleItems = pgTable('bundle_items', {
  id: serial('id').primaryKey(),
  bundleId: integer('bundle_id').notNull().references(() => bundles.id, { onDelete: 'cascade' }),
  articleSku: varchar('article_sku', { length: 100 }).notNull(),
  quantity: integer('quantity').notNull().default(1),
  isFreeGift: integer('is_free_gift').notNull().default(0),
  isTablet: integer('is_tablet').notNull().default(0),
  fixedDosageMg: integer('fixed_dosage_mg'),
  sortOrder: integer('sort_order').notNull().default(0),
});
export type BundleItem = typeof bundleItems.$inferSelect;
export type InsertBundleItem = typeof bundleItems.$inferInsert;
