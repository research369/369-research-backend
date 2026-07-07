/**
 * KWK Schema – Kunden-werben-Kunden
 *
 * ISOLIERTES MODUL: Diese Datei enthält ausschließlich neue KWK-Tabellen.
 * Keine bestehenden Tabellen werden verändert.
 *
 * Tabellen:
 *   kwk_accounts   – KWK-Teilnehmer-Datensätze (kein Kundenkonto, kein Partnerkonto)
 *   kwk_ledger     – Unveränderliches Guthaben-Ledger (führende Datenquelle)
 *   kwk_referrals  – Dauerhafte Bestellzuordnungen (revisionssicher)
 *   kwk_audit_log  – Admin-Audit-Trail
 */

import {
  pgTable,
  serial,
  varchar,
  text,
  numeric,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ── Enums ──────────────────────────────────────────────────────────────────

export const kwkStatusEnum = pgEnum("kwk_status", [
  "aktiv",
  "gesperrt",
  "review",
  "deaktiviert",
]);

export const kwkLedgerTypeEnum = pgEnum("kwk_ledger_type", [
  "pending_credit",    // Guthaben pending (Bestellung eingegangen)
  "credit_released",   // Guthaben freigegeben (Bestellung final)
  "redeemed",          // Guthaben eingelöst (Checkout)
  "cancelled",         // Gegenbuchung bei Storno
  "refund",            // Gegenbuchung bei Rückerstattung
  "manual_correction", // Admin-Korrektur
]);

export const kwkLedgerStatusEnum = pgEnum("kwk_ledger_status", [
  "pending",
  "confirmed",
  "cancelled",
]);

export const kwkReferralStatusEnum = pgEnum("kwk_referral_status", [
  "pending",
  "confirmed",
  "cancelled",
  "review",
]);

// ── kwk_accounts ──────────────────────────────────────────────────────────

export const kwkAccounts = pgTable(
  "kwk_accounts",
  {
    id: serial("id").primaryKey(),

    // KWK-Nummer: KWK-100001, KWK-100002, ...
    kwkNumber: varchar("kwk_number", { length: 20 }).notNull().unique(),

    // Empfehlungslink-Code (z.B. KWK-100001 oder kurzer Hash)
    referralCode: varchar("referral_code", { length: 50 }).notNull().unique(),

    // Pflichtfelder
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    phone: varchar("phone", { length: 50 }).notNull(),
    passwordHash: text("password_hash").notNull(),

    // Status
    status: kwkStatusEnum("status").notNull().default("aktiv"),

    // Guthaben-Cache (Performance-Felder – führende Quelle ist kwk_ledger)
    // Werden bei jeder Ledger-Buchung automatisch aktualisiert
    creditAvailable: numeric("credit_available", { precision: 10, scale: 2 }).notNull().default("0.00"),
    creditPending: numeric("credit_pending", { precision: 10, scale: 2 }).notNull().default("0.00"),
    creditRedeemed: numeric("credit_redeemed", { precision: 10, scale: 2 }).notNull().default("0.00"),

    // Optionale Felder
    company: varchar("company", { length: 255 }),
    whatsapp: varchar("whatsapp", { length: 50 }),
    notes: text("notes"),

    // Login-Sicherheit: Rate Limiting
    loginAttempts: integer("login_attempts").notNull().default(0),
    loginLockedUntil: timestamp("login_locked_until"),
    lastLogin: timestamp("last_login"),

    // Passwort-Reset
    resetToken: varchar("reset_token", { length: 128 }),
    resetTokenExpiresAt: timestamp("reset_token_expires_at"),

    // Soft Delete: niemals physisch löschen
    // Status 'deaktiviert' statt DELETE
    deletedAt: timestamp("deleted_at"), // null = aktiv, gesetzt = soft-deleted

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Indizes für häufige Suchanfragen
    emailIdx: uniqueIndex("kwk_accounts_email_idx").on(table.email),
    kwkNumberIdx: uniqueIndex("kwk_accounts_kwk_number_idx").on(table.kwkNumber),
    referralCodeIdx: uniqueIndex("kwk_accounts_referral_code_idx").on(table.referralCode),
    statusIdx: index("kwk_accounts_status_idx").on(table.status),
  })
);

// ── kwk_ledger ────────────────────────────────────────────────────────────

/**
 * Unveränderliches Guthaben-Ledger.
 * Bestehende Einträge dürfen NIEMALS geändert werden.
 * Korrekturen erfolgen ausschließlich über neue Gegenbuchungs-Einträge.
 */
export const kwkLedger = pgTable(
  "kwk_ledger",
  {
    id: serial("id").primaryKey(),

    // Verknüpfung zum KWK-Account (FK, ON DELETE RESTRICT)
    kwkId: integer("kwk_id").notNull().references(() => kwkAccounts.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),

    // Bestellreferenz (optional bei manuellen Korrekturen)
    orderId: varchar("order_id", { length: 50 }),

    // Betrag: positiv = Gutschrift, negativ = Einlösung/Gegenbuchung
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),

    // Typ der Buchung
    type: kwkLedgerTypeEnum("type").notNull(),

    // Status der Buchung
    status: kwkLedgerStatusEnum("status").notNull().default("pending"),

    // Notiz (automatisch oder Admin)
    note: text("note"),

    // Wer hat diese Buchung ausgelöst (system oder Admin-User)
    createdBy: varchar("created_by", { length: 100 }).notNull().default("system"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    // KEIN updatedAt – Ledger-Einträge sind unveränderlich
  },
  (table) => ({
    kwkIdIdx: index("kwk_ledger_kwk_id_idx").on(table.kwkId),
    orderIdIdx: index("kwk_ledger_order_id_idx").on(table.orderId),
    typeStatusIdx: index("kwk_ledger_type_status_idx").on(table.type, table.status),
  })
);

// ── kwk_referrals ─────────────────────────────────────────────────────────

/**
 * Dauerhafte, revisionssichere Bestellzuordnung.
 * Wird beim Erstellen der Bestellung erzeugt und darf danach nicht mehr geändert werden.
 * UNIQUE auf order_id: 1 Bestellung = max. 1 Referral.
 */
export const kwkReferrals = pgTable(
  "kwk_referrals",
  {
    id: serial("id").primaryKey(),

    // Werbender KWK-Teilnehmer (FK, ON DELETE RESTRICT)
    kwkId: integer("kwk_id").notNull().references(() => kwkAccounts.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),

    // Bestellung des geworbenen Kunden (UNIQUE: 1 Bestellung = 1 Referral)
    orderId: varchar("order_id", { length: 50 }).notNull().unique(),

    // Kundendaten zum Zeitpunkt der Bestellung (für Missbrauchsschutz)
    customerEmail: varchar("customer_email", { length: 255 }),
    customerPhone: varchar("customer_phone", { length: 50 }),
    customerAddressHash: varchar("customer_address_hash", { length: 64 }), // SHA-256 Hash

    // Rabatt und Guthaben
    discountApplied: numeric("discount_applied", { precision: 10, scale: 2 }).notNull().default("0.00"),
    commissionBase: numeric("commission_base", { precision: 10, scale: 2 }).notNull().default("0.00"),
    commissionAmount: numeric("commission_amount", { precision: 10, scale: 2 }).notNull().default("0.00"),

    // Missbrauchsflags (JSON: { sameEmail: bool, samePhone: bool, sameAddress: bool })
    fraudFlags: text("fraud_flags"), // JSON-String

    // Status
    status: kwkReferralStatusEnum("status").notNull().default("pending"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    // KEIN updatedAt – Referral-Zuordnung ist unveränderlich
  },
  (table) => ({
    orderIdIdx: uniqueIndex("kwk_referrals_order_id_idx").on(table.orderId),
    kwkIdIdx: index("kwk_referrals_kwk_id_idx").on(table.kwkId),
    statusIdx: index("kwk_referrals_status_idx").on(table.status),
  })
);

// ── kwk_audit_log ─────────────────────────────────────────────────────────

/**
 * Admin-Audit-Trail für alle administrativen Änderungen am KWK-System.
 */
export const kwkAuditLog = pgTable(
  "kwk_audit_log",
  {
    id: serial("id").primaryKey(),

    // Betroffener KWK-Account (optional)
    kwkId: integer("kwk_id"),

    // Admin-User der die Aktion ausgeführt hat
    adminUser: varchar("admin_user", { length: 100 }).notNull(),

    // Aktion (z.B. "status_change", "manual_credit", "account_lock")
    action: varchar("action", { length: 100 }).notNull(),

    // Alter und neuer Wert
    oldValue: text("old_value"),
    newValue: text("new_value"),

    // Begründung (optional)
    note: text("note"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    kwkIdIdx: index("kwk_audit_log_kwk_id_idx").on(table.kwkId),
    createdAtIdx: index("kwk_audit_log_created_at_idx").on(table.createdAt),
  })
);
