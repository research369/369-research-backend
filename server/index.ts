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

  app.listen(port, "0.0.0.0", () => {
    console.log(`[Server] 369 Research Backend running on port ${port}`);
  });
}

start().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
