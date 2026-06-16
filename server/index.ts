/**
 * 369 Research Backend – Express + tRPC Server
 * Standalone deployment for Railway
 */
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { ENV } from "./env.js";
import { appRouter } from "./routers.js";
import { getUserFromRequest, handleLogin, handleLogout, handleMe, seedAdminUser } from "./auth.js";
import { getPool } from "./db.js";
import type { Context } from "./trpc.js";
import { sendcloudExpressRouter } from "./sendcloudExpressRouter.js";
import { dhlExpressRouter } from "./dhlExpressRouter.js";

const app = express();

// CORS – allow frontend domains
const allowedOrigins = [
  ENV.frontendUrl,
  "https://369research.eu",
  "https://www.369research.eu",
  "http://localhost:3000",
  "http://localhost:5173",
].filter(Boolean);

app.use(cors({
  origin: true, // Allow all origins (auth is via JWT Bearer token, not cookies)
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), version: "1.1.0", fix: "paid-status-filter" });
});



// ── Rate Limiting ──────────────────────────────────────────────────
// Helper: detect Railway-internal / server-side requests (skip rate limiting)
const isInternalRequest = (req: any): boolean => {
  const forwarded = (req.headers["x-forwarded-for"] as string) || "";
  const ip = req.ip || "";
  const userAgent = (req.headers["user-agent"] as string) || "";
  // Skip for localhost, Railway internal network (10.x, 172.x) and Python requests (server-side scripts)
  return (
    ip.startsWith("127.") ||
    ip.startsWith("::1") ||
    ip.startsWith("10.") ||
    ip.startsWith("172.") ||
    forwarded.startsWith("10.") ||
    forwarded.startsWith("172.") ||
    userAgent.includes("python-requests") ||
    userAgent.includes("node-fetch") ||
    req.headers["x-internal-token"] === ENV.jwtSecret
  );
};

// Strict limiter for login: max 10 attempts per 15 minutes per IP (external only)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isInternalRequest,
  message: {
    error: "Zu viele Anmeldeversuche. Bitte versuchen Sie es in 15 Minuten erneut.",
  },
  keyGenerator: (req) => {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
  },
});

// General API limiter: max 300 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isInternalRequest,
  message: {
    error: "Zu viele Anfragen. Bitte versuchen Sie es später erneut.",
  },
  keyGenerator: (req) => {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
  },
});

// Apply general rate limit to all API routes
app.use("/api/", apiLimiter);

// Auth routes (REST, not tRPC)
app.post("/api/auth/login", loginLimiter, handleLogin);
app.post("/api/auth/logout", handleLogout);
app.get("/api/auth/me", handleMe);


// tRPC middleware
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext: async ({ req, res }): Promise<Context> => {
      const user = await getUserFromRequest(req);
      return { req, res, user };
    },
    onError: ({ error, path }) => {
      console.error(`[tRPC] Error on ${path}:`, error.message);
    },
  })
);

// ─── Sendcloud Express Router (additiv, kein Eingriff in bestehende Routes) ───
app.use(sendcloudExpressRouter);

// ─── DHL Express Router (additiv, Phase 1: DE national, Sandbox) ─────────────
app.use(dhlExpressRouter);

// Start server
const port = ENV.port;

async function start() {
  console.log("[Server] Starting 369 Research Backend...");
  console.log(`[Server] Frontend URL: ${ENV.frontendUrl}`);
  console.log(`[Server] Database: ${ENV.databaseUrl ? "configured" : "NOT configured"}`);
  console.log(`[Server] Bunq API: ${ENV.bunqApiKey ? "configured" : "NOT configured"}`);
  console.log(`[Server] Resend API: ${ENV.resendApiKey ? "configured" : "NOT configured"}`);

  // Seed admin user on first start
  try {
    await seedAdminUser();
  } catch (err) {
    console.warn("[Server] Failed to seed admin user:", err);
  }

  // Auto-migrate: add TOTP columns to users table if not exists
  try {
    const pool = await getPool();
    if (pool) {
      await pool.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled INTEGER NOT NULL DEFAULT 0;
      `);
      console.log("[Server] users TOTP columns ready");
    }
  } catch (err) {
    console.warn("[Server] Failed to add TOTP columns:", err);
  }

  // Auto-migrate: create invoices table if not exists
  try {
    const pool = await getPool();
    if (pool) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS invoices (
          id SERIAL PRIMARY KEY,
          invoice_number VARCHAR(50) NOT NULL UNIQUE,
          order_number VARCHAR(32) NOT NULL,
          date VARCHAR(10) NOT NULL,
          date_iso VARCHAR(10) NOT NULL,
          total_gross DECIMAL(10,2) NOT NULL,
          html TEXT NOT NULL,
          items TEXT NOT NULL DEFAULT '[]',
          split_index INTEGER,
          split_total INTEGER,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE INDEX IF NOT EXISTS invoices_order_number_idx ON invoices(order_number);
        CREATE INDEX IF NOT EXISTS invoices_date_iso_idx ON invoices(date_iso);
      `);
      console.log("[Server] invoices table ready");
    }
  } catch (err) {
    console.warn("[Server] Failed to create invoices table:", err);
  }

  // Auto-migrate: create batch tracking tables if not exists
  try {
    const pool = await getPool();
    if (pool) {
      await pool.query(`
        DO $$ BEGIN
          CREATE TYPE purchase_order_status AS ENUM (
            'bestellt', 'versendet', 'teilweise_eingetroffen', 'vollständig', 'abgeschlossen'
          );
        EXCEPTION WHEN duplicate_object THEN null;
        END $$;

        CREATE TABLE IF NOT EXISTS purchase_orders (
          id SERIAL PRIMARY KEY,
          po_number VARCHAR(50) NOT NULL UNIQUE,
          supplier_name VARCHAR(200) NOT NULL,
          order_date TIMESTAMP NOT NULL,
          shipping_date TIMESTAMP,
          received_date TIMESTAMP,
          tracking_number VARCHAR(100),
          status purchase_order_status NOT NULL DEFAULT 'bestellt',
          shipping_cost_usd DECIMAL(10,2),
          total_usd DECIMAL(10,2),
          usd_to_eur_rate DECIMAL(8,4),
          notes TEXT,
          screenshot_ref TEXT,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS purchase_order_items (
          id SERIAL PRIMARY KEY,
          purchase_order_id INTEGER NOT NULL,
          article_id INTEGER,
          sku VARCHAR(50),
          name VARCHAR(200) NOT NULL,
          dosage VARCHAR(50),
          supplier_code VARCHAR(100),
          ordered_qty INTEGER NOT NULL DEFAULT 0,
          received_qty INTEGER NOT NULL DEFAULT 0,
          pack_quantity INTEGER,
          pack_size INTEGER,
          purchase_price_eur DECIMAL(10,4),
          price_usd DECIMAL(10,2),
          shipping_markup DECIMAL(5,4),
          usd_to_eur_rate DECIMAL(8,4),
          selling_price DECIMAL(10,2),
          batch_number VARCHAR(100),
          received_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS batches (
          id SERIAL PRIMARY KEY,
          batch_number VARCHAR(100) NOT NULL,
          article_id INTEGER NOT NULL,
          article_name VARCHAR(200) NOT NULL,
          purchase_order_id INTEGER,
          purchase_order_item_id INTEGER,
          supplier_name VARCHAR(200),
          quantity INTEGER NOT NULL DEFAULT 0,
          remaining_qty INTEGER NOT NULL DEFAULT 0,
          received_date TIMESTAMP,
          notes TEXT,
          is_active INTEGER DEFAULT 1 NOT NULL,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS order_item_batches (
          id SERIAL PRIMARY KEY,
          order_id VARCHAR(32) NOT NULL,
          order_item_id INTEGER,
          article_id INTEGER,
          article_name VARCHAR(200) NOT NULL,
          batch_id INTEGER,
          batch_number VARCHAR(100) NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          assigned_by VARCHAR(100),
          assigned_at TIMESTAMP DEFAULT NOW() NOT NULL,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_po_items_po_id ON purchase_order_items(purchase_order_id);
        CREATE INDEX IF NOT EXISTS idx_batches_article_id ON batches(article_id);
        CREATE INDEX IF NOT EXISTS idx_batches_batch_number ON batches(batch_number);
        CREATE INDEX IF NOT EXISTS idx_order_item_batches_order_id ON order_item_batches(order_id);
        CREATE INDEX IF NOT EXISTS idx_order_item_batches_article_id ON order_item_batches(article_id);
      `);
      console.log("[Server] Batch tracking tables ready");
    }
  } catch (err) {
    console.warn("[Server] Failed to create batch tracking tables:", err);
  }

  // Auto-migrate: performance indexes for orders table
  try {
    const pool = await getPool();
    if (pool) {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
        CREATE INDEX IF NOT EXISTS orders_order_date_idx ON orders(order_date);
        CREATE INDEX IF NOT EXISTS orders_customer_id_idx ON orders(customer_id);
        CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(email);
      `);
      console.log("[Server] orders performance indexes ready");
    }
  } catch (err) {
    console.warn("[Server] Failed to create orders indexes:", err);
  }

  // Auto-migrate: Follow-up Modul Tabellen
  try {
    const pool = await getPool();
    if (pool) {
      await pool.query(`
        DO $$ BEGIN
          CREATE TYPE follow_up_status AS ENUM ('pending', 'done', 'skipped');
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;

        CREATE TABLE IF NOT EXISTS sales_followups (
          id SERIAL PRIMARY KEY,
          order_id VARCHAR(32) NOT NULL UNIQUE,
          status follow_up_status NOT NULL DEFAULT 'pending',
          due_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          skipped_at TIMESTAMP,
          completed_by VARCHAR(100),
          whatsapp_message TEXT,
          email_subject VARCHAR(300),
          email_body TEXT,
          email_sent_at TIMESTAMP,
          email_sent_to VARCHAR(320),
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS sales_followup_products (
          id SERIAL PRIMARY KEY,
          followup_id INTEGER NOT NULL,
          article_id INTEGER NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_sales_followups_status ON sales_followups(status);
        CREATE INDEX IF NOT EXISTS idx_sales_followups_due_at ON sales_followups(due_at);
        CREATE INDEX IF NOT EXISTS idx_sales_followup_products_followup_id ON sales_followup_products(followup_id);
      `);
      // Idempotent migration: add code fields + reminder_stage to sales_followups
      await pool.query(`
        ALTER TABLE sales_followups
          ADD COLUMN IF NOT EXISTS promo_code_id INTEGER,
          ADD COLUMN IF NOT EXISTS discount_code VARCHAR(50),
          ADD COLUMN IF NOT EXISTS code_created_at TIMESTAMP,
          ADD COLUMN IF NOT EXISTS code_expires_at TIMESTAMP,
          ADD COLUMN IF NOT EXISTS message_generated_at TIMESTAMP,
          ADD COLUMN IF NOT EXISTS whatsapp_opened_at TIMESTAMP,
          ADD COLUMN IF NOT EXISTS reminder_stage INTEGER NOT NULL DEFAULT 1;
      `);
      console.log("[Server] Follow-up tables ready (incl. code fields v2)");
    }
  } catch (err) {
    console.warn("[Server] Failed to create follow-up tables:", err);
  }

  // Cross-Sell Ranking: followUpCategory Feld in articles
  try {
    const pool = await getPool();
    if (pool) {
      await pool.query(`
        ALTER TABLE articles
          ADD COLUMN IF NOT EXISTS follow_up_category VARCHAR(50);
      `);
      console.log("[Server] articles.follow_up_category migration OK");
    }
  } catch (err) {
    console.warn("[Server] Failed to add follow_up_category to articles:", err);
  }

  // FEHLER-019 Fix: Backfill customers from orders (one-time, idempotent)
  // Creates customer records for orders that predate the customers table
  try {
    const pool = await getPool();
    if (pool) {
      const PLACEHOLDER_EMAILS = new Set([
        'keine@angabe.de', 'noemail@noemail.de', 'no@email.de', 'noreply@noreply.de',
        'placeholder@placeholder.de', 'test@test.de', 'info@info.de', 'otc@369research.eu',
      ]);
      const normalizePhone = (p: string) => (p || '').replace(/[\s\-\.\(\)]/g, '');

      // Get all existing customers
      const custRes = await pool.query('SELECT id, email, phone FROM customers');
      const existingEmails = new Set<string>();
      const existingPhones = new Set<string>();
      for (const c of custRes.rows) {
        if (c.email) {
          const k = c.email.toLowerCase().trim();
          if (!PLACEHOLDER_EMAILS.has(k)) existingEmails.add(k);
        }
        if (c.phone) {
          const k = normalizePhone(c.phone);
          if (k.length >= 8) existingPhones.add(k);
        }
      }

      // Get all orders without a customer_id
      const ordersRes = await pool.query(
        'SELECT * FROM orders WHERE customer_id IS NULL ORDER BY order_date DESC'
      );

      // Get max customer number
      const maxRes = await pool.query(
        "SELECT COALESCE(MAX(CAST(customer_number AS INTEGER)), 1209) as max_num FROM customers WHERE customer_number ~ '^[0-9]+$'"
      );
      let nextNum = Math.max(1210, parseInt(maxRes.rows[0]?.max_num || '1209') + 1);

      // Group orders by identity key
      const groups: Record<string, any[]> = {};
      for (const o of ordersRes.rows) {
        const emailKey = (o.email || '').toLowerCase().trim();
        const phoneKey = normalizePhone(o.phone || '');
        const emailUsable = emailKey && !PLACEHOLDER_EMAILS.has(emailKey);
        const phoneUsable = phoneKey.length >= 8;
        if (emailUsable && existingEmails.has(emailKey)) continue;
        if (!emailUsable && phoneUsable && existingPhones.has(phoneKey)) continue;
        const gk = emailUsable ? `e:${emailKey}` : (phoneUsable ? `p:${phoneKey}` : `o:${o.order_id}`);
        if (!groups[gk]) groups[gk] = [];
        groups[gk].push(o);
      }

      let created = 0;
      for (const [, grpOrders] of Object.entries(groups)) {
        const o = grpOrders[0];
        const firstName = o.first_name || '';
        const lastName = o.last_name || '';
        const name = `${firstName} ${lastName}`.trim();
        if (!name) continue;
        const emailKey = (o.email || '').toLowerCase().trim();
        const emailUsable = emailKey && !PLACEHOLDER_EMAILS.has(emailKey);
        const totalOrders = grpOrders.length;
        const totalSpent = grpOrders.reduce((s: number, x: any) => s + parseFloat(x.total || '0'), 0);
        const dates = grpOrders.map((x: any) => x.order_date).filter(Boolean).sort();
        try {
          await pool.query(
            `INSERT INTO customers
              (customer_number, name, first_name, last_name, phone, email, company,
               street, house_number, zip, city, country, source,
               total_orders, total_spent, first_order_date, last_order_date, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())`,
            [
              String(nextNum), name, firstName || null, lastName || null,
              o.phone || null, emailUsable ? o.email : null, o.company || null,
              o.street || null, o.house_number || null, o.zip || null,
              o.city || null, o.country || null, 'backfill',
              totalOrders, totalSpent.toFixed(2),
              dates[0] || null, dates[dates.length - 1] || null,
            ]
          );
          if (emailUsable) existingEmails.add(emailKey);
          const pk = normalizePhone(o.phone || '');
          if (pk.length >= 8) existingPhones.add(pk);
          nextNum++;
          created++;
        } catch (_e) { /* skip duplicates */ }
      }
      if (created > 0) {
        console.log(`[Server] FEHLER-019 Backfill: created ${created} customer records from orders`);
      } else {
        console.log('[Server] FEHLER-019 Backfill: no new customers needed (all already exist)');
      }
    }
  } catch (err) {
    console.warn('[Server] FEHLER-019 Backfill failed (non-fatal):', err);
  }

  // Auto-migrate: DHL EU – weight_grams column for orders
  try {
    const pool = await getPool();
    if (pool) {
      await pool.query(`
        ALTER TABLE orders
          ADD COLUMN IF NOT EXISTS weight_grams INTEGER;
      `);
      console.log('[Server] orders.weight_grams column ready (DHL EU)');
    }
  } catch (err) {
    console.warn('[Server] Failed to add weight_grams column (non-fatal):', err);
  }

  // Auto-migrate: SNAP-8 neues Vial-Mockup-Bild
  try {
    const pool = await getPool();
    if (pool) {
      const newImage = 'https://d2xsxph8kpxj0f.cloudfront.net/119871539/Pbxbt3ufs2MSgiEmtAeTCd/snap-8-vial-mockup-NPaq4ogk8uuXj3mBWNBGW5.png';
      await pool.query(
        `UPDATE articles SET mockup_image_url = $1 WHERE shop_product_id = 'snap-8' AND (mockup_image_url IS NULL OR mockup_image_url != $1)`,
        [newImage]
      );
      console.log('[Server] SNAP-8 Vial-Mockup aktualisiert');
    }
  } catch (err) {
    console.warn('[Server] SNAP-8 Bild-Update fehlgeschlagen (non-fatal):', err);
  }

  // Auto-migrate: Sprint 1 – Mehrsprachigkeit, SEO, Merchant Center (additiv, idempotent)
  try {
    const pool = await getPool();
    if (pool) {
      // 1. articles: 3 neue Felder
      await pool.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS published_at TIMESTAMP`);
      await pool.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS nasal_spray_image_url TEXT`);
      await pool.query(`ALTER TABLE articles ADD COLUMN IF NOT EXISTS bundle_deal JSONB`);

      // 2. article_translations
      await pool.query(`
        CREATE TABLE IF NOT EXISTS article_translations (
          id SERIAL PRIMARY KEY,
          article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
          lang VARCHAR(5) NOT NULL,
          name VARCHAR(200),
          short_description TEXT,
          description JSONB,
          seo_title VARCHAR(70),
          seo_description VARCHAR(160),
          merchant_title VARCHAR(150),
          merchant_description TEXT,
          image_alt VARCHAR(200),
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
          CONSTRAINT article_translations_article_lang_unique UNIQUE (article_id, lang)
        )
      `);

      // 3. article_seo
      await pool.query(`
        CREATE TABLE IF NOT EXISTS article_seo (
          id SERIAL PRIMARY KEY,
          article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
          slug VARCHAR(200) NOT NULL,
          canonical TEXT,
          robots VARCHAR(50) DEFAULT 'index,follow',
          schema_enabled INTEGER DEFAULT 1,
          faq_enabled INTEGER DEFAULT 0,
          og_image TEXT,
          priority DECIMAL(2,1) DEFAULT 0.8,
          changefreq VARCHAR(20) DEFAULT 'weekly',
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
          CONSTRAINT article_seo_article_id_unique UNIQUE (article_id),
          CONSTRAINT article_seo_slug_unique UNIQUE (slug)
        )
      `);

      // 4. article_merchant
      await pool.query(`
        CREATE TABLE IF NOT EXISTS article_merchant (
          id SERIAL PRIMARY KEY,
          article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
          google_product_category VARCHAR(10),
          product_type VARCHAR(200),
          gtin VARCHAR(14),
          mpn VARCHAR(70),
          availability VARCHAR(20) DEFAULT 'in_stock',
          shipping_label VARCHAR(50),
          condition VARCHAR(10) DEFAULT 'new',
          age_group VARCHAR(20) DEFAULT 'adult',
          custom_label_0 VARCHAR(100),
          custom_label_1 VARCHAR(100),
          custom_label_2 VARCHAR(100),
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
          CONSTRAINT article_merchant_article_id_unique UNIQUE (article_id)
        )
      `);

      // 5. categories
      await pool.query(`
        CREATE TABLE IF NOT EXISTS categories (
          id SERIAL PRIMARY KEY,
          slug VARCHAR(200) NOT NULL,
          parent_id INTEGER,
          image_url TEXT,
          sort_order INTEGER DEFAULT 0,
          visible INTEGER DEFAULT 1,
          type VARCHAR(50) DEFAULT 'shop',
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
          CONSTRAINT categories_slug_unique UNIQUE (slug)
        )
      `);

      // 6. category_translations
      await pool.query(`
        CREATE TABLE IF NOT EXISTS category_translations (
          id SERIAL PRIMARY KEY,
          category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          lang VARCHAR(5) NOT NULL,
          name VARCHAR(200),
          description TEXT,
          seo_title VARCHAR(70),
          seo_description VARCHAR(160),
          image_alt VARCHAR(200),
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
          CONSTRAINT category_translations_category_lang_unique UNIQUE (category_id, lang)
        )
      `);

      // Performance-Indizes
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_article_translations_article_id ON article_translations(article_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_article_translations_lang ON article_translations(lang)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_article_seo_slug ON article_seo(slug)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_article_merchant_article_id ON article_merchant(article_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_category_translations_category_id ON category_translations(category_id)`);

      console.log('[Server] Sprint 1 Migration: alle Tabellen und Felder angelegt (idempotent)');
    }
  } catch (err) {
    console.warn('[Server] Sprint 1 Migration fehlgeschlagen (non-fatal):', err);
  }

  // Auto-migrate: Sprint 2 – article_seo und article_merchant erweitern (additiv, idempotent)
  try {
    const pool2 = await getPool();
    if (pool2) {
      // article_seo: seoTitle, seoDescription, imageAlt, hreflang
      await pool2.query(`ALTER TABLE article_seo ADD COLUMN IF NOT EXISTS seo_title VARCHAR(70)`);
      await pool2.query(`ALTER TABLE article_seo ADD COLUMN IF NOT EXISTS seo_description VARCHAR(160)`);
      await pool2.query(`ALTER TABLE article_seo ADD COLUMN IF NOT EXISTS image_alt VARCHAR(200)`);
      await pool2.query(`ALTER TABLE article_seo ADD COLUMN IF NOT EXISTS hreflang TEXT`);
      // article_merchant: brand
      await pool2.query(`ALTER TABLE article_merchant ADD COLUMN IF NOT EXISTS brand VARCHAR(100) DEFAULT '369 Research'`);
      console.log('[Server] Sprint 2 Migration: article_seo + article_merchant erweitert (idempotent)');
    }
  } catch (err) {
    console.warn('[Server] Sprint 2 Migration fehlgeschlagen (non-fatal):', err);
  }

  // ============================================================
  // MIGRATION SYSTEM – schema_migrations Versionstabelle
  // Jede Migration wird nur EINMAL ausgeführt.
  // KEINE Änderungen an: orders, customers, invoices, stock_history,
  //   checkout, payments, academy, DHL, WaWi Business Logik.
  // Nur: Knowledge Layer, SEO, Merchant, FAQ, Use Cases.
  // ============================================================
  try {
    const pool = await getPool();
    if (pool) {
      // 1. schema_migrations Tabelle erstellen (falls nicht vorhanden)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id             SERIAL PRIMARY KEY,
          migration_name VARCHAR(200) NOT NULL,
          executed_at    TIMESTAMP NOT NULL DEFAULT NOW(),
          CONSTRAINT schema_migrations_name_unique UNIQUE (migration_name)
        )
      `);
      console.log('[Migrations] schema_migrations table ready');

      // 2. Migration 0012: Knowledge Layer
      const m0012 = await pool.query(
        `SELECT 1 FROM schema_migrations WHERE migration_name = '0012_knowledge_layer' LIMIT 1`
      );
      if ((m0012.rowCount ?? 0) === 0) {
        console.log('[Migrations] Running 0012_knowledge_layer...');
        await pool.query(`
          CREATE TABLE IF NOT EXISTS use_cases (
            id          SERIAL PRIMARY KEY,
            slug        VARCHAR(100) NOT NULL,
            icon        VARCHAR(50),
            is_active   SMALLINT NOT NULL DEFAULT 1,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT use_cases_slug_unique UNIQUE (slug)
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS use_case_translations (
            id              SERIAL PRIMARY KEY,
            use_case_id     INTEGER NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
            lang            VARCHAR(10) NOT NULL,
            title           VARCHAR(200) NOT NULL,
            hero_text       TEXT,
            seo_title       VARCHAR(70),
            seo_description VARCHAR(160),
            created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT use_case_translations_unique UNIQUE (use_case_id, lang)
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS article_use_cases (
            id          SERIAL PRIMARY KEY,
            article_id  INTEGER NOT NULL,
            use_case_id INTEGER NOT NULL REFERENCES use_cases(id) ON DELETE CASCADE,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT article_use_cases_unique UNIQUE (article_id, use_case_id)
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS article_tags (
            id          SERIAL PRIMARY KEY,
            article_id  INTEGER NOT NULL,
            tag         VARCHAR(100) NOT NULL,
            created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT article_tags_unique UNIQUE (article_id, tag)
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS article_faq (
            id             SERIAL PRIMARY KEY,
            article_id     INTEGER NOT NULL,
            lang           VARCHAR(10) NOT NULL,
            question       TEXT NOT NULL,
            answer         TEXT NOT NULL,
            sort_order     INTEGER NOT NULL DEFAULT 0,
            schema_enabled SMALLINT NOT NULL DEFAULT 1,
            created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT article_faq_unique UNIQUE (article_id, lang, sort_order)
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS article_studies (
            id               SERIAL PRIMARY KEY,
            article_id       INTEGER NOT NULL,
            pubmed_id        VARCHAR(20),
            doi              VARCHAR(200),
            title            TEXT NOT NULL,
            authors          TEXT,
            journal          VARCHAR(200),
            year             SMALLINT,
            study_type       VARCHAR(50),
            population       VARCHAR(100),
            keywords         TEXT,
            summary_de       TEXT,
            summary_en       TEXT,
            url              TEXT,
            created_at       TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS article_bundles (
            id             SERIAL PRIMARY KEY,
            slug           VARCHAR(100) NOT NULL,
            name_de        VARCHAR(200) NOT NULL,
            name_en        VARCHAR(200),
            description_de TEXT,
            description_en TEXT,
            is_active      SMALLINT NOT NULL DEFAULT 1,
            sort_order     INTEGER NOT NULL DEFAULT 0,
            created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT article_bundles_slug_unique UNIQUE (slug)
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS article_bundle_items (
            id          SERIAL PRIMARY KEY,
            bundle_id   INTEGER NOT NULL REFERENCES article_bundles(id) ON DELETE CASCADE,
            article_id  INTEGER NOT NULL,
            quantity    INTEGER NOT NULL DEFAULT 1,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT article_bundle_items_unique UNIQUE (bundle_id, article_id)
          )
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS article_comparisons (
            id             SERIAL PRIMARY KEY,
            article_id_a   INTEGER NOT NULL,
            article_id_b   INTEGER NOT NULL,
            slug           VARCHAR(200) NOT NULL,
            summary_de     TEXT,
            summary_en     TEXT,
            winner_note_de TEXT,
            winner_note_en TEXT,
            created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT article_comparisons_unique UNIQUE (article_id_a, article_id_b)
          )
        `);
        await pool.query(
          `INSERT INTO schema_migrations (migration_name) VALUES ('0012_knowledge_layer')
           ON CONFLICT (migration_name) DO NOTHING`
        );
        console.log('[Migrations] 0012_knowledge_layer: DONE');
      } else {
        console.log('[Migrations] 0012_knowledge_layer: already applied, skipping');
      }

      // 3. Migration 0013: Sprint 5 Extensions
      const m0013 = await pool.query(
        `SELECT 1 FROM schema_migrations WHERE migration_name = '0013_sprint5_extensions' LIMIT 1`
      );
      if ((m0013.rowCount ?? 0) === 0) {
        console.log('[Migrations] Running 0013_sprint5_extensions...');
        await pool.query(`ALTER TABLE use_cases ADD COLUMN IF NOT EXISTS icon VARCHAR(50)`);
        await pool.query(`ALTER TABLE use_cases ADD COLUMN IF NOT EXISTS is_active SMALLINT NOT NULL DEFAULT 1`);
        await pool.query(`ALTER TABLE article_faq ADD COLUMN IF NOT EXISTS schema_enabled SMALLINT NOT NULL DEFAULT 1`);
        await pool.query(`ALTER TABLE article_studies ADD COLUMN IF NOT EXISTS study_type VARCHAR(50)`);
        await pool.query(`ALTER TABLE article_studies ADD COLUMN IF NOT EXISTS population VARCHAR(100)`);
        await pool.query(`ALTER TABLE article_studies ADD COLUMN IF NOT EXISTS keywords TEXT`);
        await pool.query(`
          DO $$ BEGIN
            IF EXISTS (
              SELECT 1 FROM information_schema.tables
              WHERE table_name = 'article_merchant' AND table_schema = 'public'
            ) THEN
              ALTER TABLE article_merchant ADD COLUMN IF NOT EXISTS sale_price DECIMAL(10,2);
              ALTER TABLE article_merchant ADD COLUMN IF NOT EXISTS sale_price_effective_date VARCHAR(50);
              ALTER TABLE article_merchant ADD COLUMN IF NOT EXISTS shipping TEXT;
              ALTER TABLE article_merchant ADD COLUMN IF NOT EXISTS identifier_exists VARCHAR(10);
              ALTER TABLE article_merchant ADD COLUMN IF NOT EXISTS merchant_title VARCHAR(200);
              ALTER TABLE article_merchant ADD COLUMN IF NOT EXISTS merchant_description TEXT;
              ALTER TABLE article_merchant ADD COLUMN IF NOT EXISTS canonical_url TEXT;
              ALTER TABLE article_merchant ADD COLUMN IF NOT EXISTS image_link TEXT;
            END IF;
          END $$
        `);
        await pool.query(
          `INSERT INTO schema_migrations (migration_name) VALUES ('0013_sprint5_extensions')
           ON CONFLICT (migration_name) DO NOTHING`
        );
        console.log('[Migrations] 0013_sprint5_extensions: DONE');
      } else {
        console.log('[Migrations] 0013_sprint5_extensions: already applied, skipping');
      }
    }
  } catch (err) {
    console.warn('[Migrations] Migration system error (non-fatal):', err);
  }
  // ============================================================

  app.listen(port, "0.0.0.0", () => {
    console.log(`[Server] 369 Research Backend running on port ${port}`);
  });
}

start().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
