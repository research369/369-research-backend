import { integer, pgTable, text, timestamp, varchar, decimal, pgEnum, serial } from "drizzle-orm/pg-core";

/**
 * Enums
 */
export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
export const stockChangeTypeEnum = pgEnum("stock_change_type", ["wareneingang", "verkauf", "korrektur", "retoure", "bestellung"]);
export const paymentMethodEnum = pgEnum("payment_method", ["bunq", "creditCard", "wise", "SEPA", "Bar", "Kreditkarte", "PayPal", "Crypto", "Guthaben", "Sonstige"]);
export const orderStatusEnum = pgEnum("order_status", ["offen", "bezahlt", "gepackt", "versendet", "zugestellt", "storniert"]);

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

  isActive: integer("is_active").default(1).notNull(),
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
  name: varchar("name", { length: 200 }).notNull(),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 320 }),
  company: varchar("company", { length: 200 }),

  street: varchar("street", { length: 200 }),
  zip: varchar("zip", { length: 20 }),
  city: varchar("city", { length: 100 }),
  country: varchar("country", { length: 100 }),

  notes: text("notes"),
  totalOrders: integer("total_orders").default(0).notNull(),
  totalSpent: decimal("total_spent", { precision: 10, scale: 2 }).default("0").notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;

/**
 * Orders table – stores all shop orders
 */
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderId: varchar("order_id", { length: 32 }).notNull().unique(),

  // Customer info
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  phone: varchar("phone", { length: 50 }).notNull(),
  street: varchar("street", { length: 200 }).notNull(),
  houseNumber: varchar("house_number", { length: 20 }).notNull(),
  zip: varchar("zip", { length: 20 }).notNull(),
  city: varchar("city", { length: 100 }).notNull(),
  country: varchar("country", { length: 100 }).notNull(),
  company: varchar("company", { length: 200 }),

  // Link to customer record (optional)
  customerId: integer("customer_id"),

  // Financials
  subtotal: decimal("subtotal", { precision: 10, scale: 2 }).notNull(),
  discount: decimal("discount", { precision: 10, scale: 2 }).notNull().default("0"),
  discountCode: varchar("discount_code", { length: 50 }),
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

  // Shipping label URL
  shippingLabelUrl: text("shipping_label_url"),

  // Partner / Affiliate
  partnerCode: varchar("partner_code", { length: 50 }),
  partnerNumber: varchar("partner_number", { length: 50 }),
  partnerDiscount: decimal("partner_discount", { precision: 10, scale: 2 }).default("0"),
  partnerCommission: decimal("partner_commission", { precision: 10, scale: 2 }).default("0"),
  creditUsed: decimal("credit_used", { precision: 10, scale: 2 }).default("0"),

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
});

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

  // Active flag
  isActive: integer("is_active").default(1).notNull(),

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
export const partnerTransactionTypeEnum = pgEnum("partner_transaction_type", ["provision", "einloesung", "korrektur"]);

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

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PartnerTransaction = typeof partnerTransactions.$inferSelect;
export type InsertPartnerTransaction = typeof partnerTransactions.$inferInsert;
