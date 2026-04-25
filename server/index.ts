/**
 * 369 Research Backend – Express + tRPC Server
 * Standalone deployment for Railway
 */
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import superjson from "superjson";
import { ENV } from "./env.js";
import { appRouter } from "./routers.js";
import { getUserFromRequest, handleLogin, handleLogout, handleMe, seedAdminUser } from "./auth.js";
import type { Context } from "./trpc.js";
import { getPool } from "./db.js";

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
  res.json({ status: "ok", timestamp: new Date().toISOString(), version: "1.0.0" });
});

// ── Rate Limiting ──────────────────────────────────────────────────
// Strict limiter for login: max 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Zu viele Anmeldeversuche. Bitte versuchen Sie es in 15 Minuten erneut.",
  },
  keyGenerator: (req) => {
    // Use X-Forwarded-For for Railway proxy, fallback to IP
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
  },
});

// General API limiter: max 100 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
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

// ── Temporary migration fix endpoint (secured with JWT_SECRET) ──
app.post("/api/fix-missing-migrations", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${ENV.jwtSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const pool = getPool();
    if (!pool) throw new Error("Pool not available");

    const results: string[] = [];

    // ── Migration 0002: payment_method ENUM additions + promo tables ──
    const enumValues = ['SEPA', 'Bar', 'Kreditkarte', 'PayPal', 'Crypto', 'Guthaben', 'Sonstige'];
    for (const val of enumValues) {
      try {
        await pool.query(`ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS '${val}'`);
        results.push(`payment_method: added '${val}'`);
      } catch (e: any) {
        results.push(`payment_method: '${val}' – ${e.message}`);
      }
    }

    // promo_code_discount_type enum
    try {
      await pool.query(`CREATE TYPE "public"."promo_code_discount_type" AS ENUM('percent', 'fixed')`);
      results.push('Created promo_code_discount_type enum');
    } catch (e: any) {
      results.push(`promo_code_discount_type: ${e.message.includes('already exists') ? 'already exists' : e.message}`);
    }

    // partner_code_usage table
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS "partner_code_usage" (
        "id" serial PRIMARY KEY NOT NULL,
        "partner_code" varchar(50) NOT NULL,
        "email" varchar(320) NOT NULL,
        "order_id" varchar(32) NOT NULL,
        "used_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "partner_code_usage_email_unique" UNIQUE("email")
      )`);
      results.push('Created partner_code_usage table');
    } catch (e: any) {
      results.push(`partner_code_usage: ${e.message}`);
    }

    // promo_codes table
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS "promo_codes" (
        "id" serial PRIMARY KEY NOT NULL,
        "code" varchar(50) NOT NULL,
        "discount_type" "promo_code_discount_type" DEFAULT 'percent' NOT NULL,
        "percentage" numeric(5, 2) DEFAULT '0',
        "fixed_amount" numeric(10, 2) DEFAULT '0',
        "min_order" numeric(10, 2) DEFAULT '0',
        "max_uses" integer DEFAULT 0,
        "current_uses" integer DEFAULT 0 NOT NULL,
        "valid_from" timestamp,
        "valid_until" timestamp,
        "is_active" integer DEFAULT 1 NOT NULL,
        "description" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "promo_codes_code_unique" UNIQUE("code")
      )`);
      results.push('Created promo_codes table');
    } catch (e: any) {
      results.push(`promo_codes: ${e.message}`);
    }

    // ── Migration 0003: communication types + tables + shop_settings ──
    const enumDefs = [
      { name: 'communication_status', values: "'sent', 'failed', 'draft', 'logged'" },
      { name: 'communication_type', values: "'email', 'note', 'whatsapp', 'phone'" },
      { name: 'email_campaign_status', values: "'draft', 'sending', 'sent', 'failed'" },
    ];
    for (const e of enumDefs) {
      try {
        await pool.query(`CREATE TYPE "public"."${e.name}" AS ENUM(${e.values})`);
        results.push(`Created ${e.name} enum`);
      } catch (err: any) {
        results.push(`${e.name}: ${err.message.includes('already exists') ? 'already exists' : err.message}`);
      }
    }

    // customer_communications table
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS "customer_communications" (
        "id" serial PRIMARY KEY NOT NULL,
        "customer_id" integer NOT NULL,
        "type" "communication_type" NOT NULL,
        "status" "communication_status" DEFAULT 'logged' NOT NULL,
        "subject" varchar(500),
        "body" text,
        "html_body" text,
        "recipient_email" varchar(320),
        "sender_name" varchar(200),
        "order_id" varchar(32),
        "campaign_id" integer,
        "created_by" varchar(100),
        "created_at" timestamp DEFAULT now() NOT NULL
      )`);
      results.push('Created customer_communications table');
    } catch (e: any) {
      results.push(`customer_communications: ${e.message}`);
    }

    // email_campaigns table
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS "email_campaigns" (
        "id" serial PRIMARY KEY NOT NULL,
        "name" varchar(200) NOT NULL,
        "subject" varchar(500) NOT NULL,
        "html_body" text NOT NULL,
        "template_id" integer,
        "status" "email_campaign_status" DEFAULT 'draft' NOT NULL,
        "recipient_count" integer DEFAULT 0 NOT NULL,
        "sent_count" integer DEFAULT 0 NOT NULL,
        "failed_count" integer DEFAULT 0 NOT NULL,
        "filter_criteria" text,
        "sent_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      )`);
      results.push('Created email_campaigns table');
    } catch (e: any) {
      results.push(`email_campaigns: ${e.message}`);
    }

    // email_templates table
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS "email_templates" (
        "id" serial PRIMARY KEY NOT NULL,
        "name" varchar(200) NOT NULL,
        "subject" varchar(500) NOT NULL,
        "html_body" text NOT NULL,
        "description" text,
        "is_active" integer DEFAULT 1 NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      )`);
      results.push('Created email_templates table');
    } catch (e: any) {
      results.push(`email_templates: ${e.message}`);
    }

    // shop_settings table
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS "shop_settings" (
        "id" serial PRIMARY KEY NOT NULL,
        "key" varchar(100) NOT NULL,
        "value" text NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "shop_settings_key_unique" UNIQUE("key")
      )`);
      results.push('Created shop_settings table');
    } catch (e: any) {
      results.push(`shop_settings: ${e.message}`);
    }

    // customers additional columns from migration 0003
    const custCols = [
      { col: 'customer_number', def: 'varchar(20)' },
      { col: 'first_name', def: 'varchar(100)' },
      { col: 'last_name', def: 'varchar(100)' },
      { col: 'house_number', def: 'varchar(20)' },
      { col: 'tags', def: 'text' },
      { col: 'source', def: 'varchar(100)' },
      { col: 'first_order_date', def: 'timestamp' },
      { col: 'last_order_date', def: 'timestamp' },
    ];
    for (const c of custCols) {
      try {
        await pool.query(`ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "${c.col}" ${c.def}`);
        results.push(`customers.${c.col}: added`);
      } catch (e: any) {
        results.push(`customers.${c.col}: ${e.message}`);
      }
    }

    // ── Migration 0004: partner address columns ──
    const partnerCols = [
      { col: 'street', def: 'varchar(200)' },
      { col: 'house_number', def: 'varchar(20)' },
      { col: 'zip', def: 'varchar(20)' },
      { col: 'city', def: 'varchar(100)' },
      { col: 'country', def: 'varchar(100)' },
    ];
    for (const c of partnerCols) {
      try {
        await pool.query(`ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "${c.col}" ${c.def}`);
        results.push(`partners.${c.col}: added`);
      } catch (e: any) {
        results.push(`partners.${c.col}: ${e.message}`);
      }
    }

    res.json({ success: true, message: "All missing migrations applied", results });
  } catch (err: any) {
    console.error("[Fix Migrations] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

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

  app.listen(port, "0.0.0.0", () => {
    console.log(`[Server] 369 Research Backend running on port ${port}`);
  });
}

start().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
