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

// ── Temporary: Fix enum values from other chat's migration ──
app.post("/api/fix-enums-0006", async (req, res) => {
  try {
    const secret = req.headers["x-migration-secret"];
    if (secret !== ENV.jwtSecret) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const pool = await getPool();
    if (!pool) return res.status(500).json({ error: "No DB pool" });
    
    const results: string[] = [];
    
    // Check current enum values
    const enumCheck = await pool.query(`SELECT unnest(enum_range(NULL::transaction_status))::text as val`);
    const currentValues = enumCheck.rows.map((r: any) => r.val);
    results.push(`Current enum values: ${JSON.stringify(currentValues)}`);
    
    // If the enum has English values, we need to rename them
    if (currentValues.includes('active') && !currentValues.includes('normal')) {
      // Rename enum values from English to German
      await pool.query(`ALTER TYPE transaction_status RENAME VALUE 'active' TO 'normal'`);
      results.push('Renamed active -> normal');
      await pool.query(`ALTER TYPE transaction_status RENAME VALUE 'cancelled' TO 'storniert'`);
      results.push('Renamed cancelled -> storniert');
      await pool.query(`ALTER TYPE transaction_status RENAME VALUE 'excluded' TO 'nicht_gewertet'`);
      results.push('Renamed excluded -> nicht_gewertet');
      await pool.query(`ALTER TYPE transaction_status RENAME VALUE 'hidden' TO 'ausgeblendet'`);
      results.push('Renamed hidden -> ausgeblendet');
      
      // Update any existing rows that use old values
      await pool.query(`UPDATE partner_transactions SET status = 'normal' WHERE status IS NULL`);
      results.push('Updated NULL statuses to normal');
    } else {
      results.push('Enum values already correct (German), no changes needed');
    }
    
    // Also check if admin_note column exists
    const colCheck = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'partner_transactions' AND column_name = 'admin_note'`);
    if (colCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE partner_transactions ADD COLUMN admin_note TEXT`);
      results.push('Added admin_note column');
    } else {
      results.push('admin_note column already exists');
    }
    
    // Check if assigned_partner_id exists on customers
    const custColCheck = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'assigned_partner_id'`);
    if (custColCheck.rows.length === 0) {
      await pool.query(`ALTER TABLE customers ADD COLUMN assigned_partner_id INTEGER REFERENCES partners(id)`);
      results.push('Added assigned_partner_id to customers');
    } else {
      results.push('assigned_partner_id already exists on customers');
    }
    
    res.json({ success: true, results });
  } catch (err: any) {
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
