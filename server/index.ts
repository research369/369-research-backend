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

// ── Temporary fix endpoint: widen varchar fields (secured with JWT_SECRET) ──
app.post("/api/fix-varchar-fields", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${ENV.jwtSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const pool = await getPool();
    if (!pool) throw new Error("Pool not available");

    const results: string[] = [];

    // Widen house_number in all tables from varchar(20) to varchar(100)
    const alterStatements = [
      `ALTER TABLE orders ALTER COLUMN house_number TYPE varchar(100)`,
      `ALTER TABLE customers ALTER COLUMN house_number TYPE varchar(100)`,
      `ALTER TABLE partners ALTER COLUMN house_number TYPE varchar(100)`,
      // Also widen street fields to be safe
      `ALTER TABLE orders ALTER COLUMN street TYPE varchar(300)`,
      `ALTER TABLE customers ALTER COLUMN street TYPE varchar(300)`,
      `ALTER TABLE partners ALTER COLUMN street TYPE varchar(300)`,
      // Widen first_name and last_name in orders (for multi-part names)
      `ALTER TABLE orders ALTER COLUMN first_name TYPE varchar(200)`,
      `ALTER TABLE orders ALTER COLUMN last_name TYPE varchar(200)`,
      `ALTER TABLE customers ALTER COLUMN first_name TYPE varchar(200)`,
      `ALTER TABLE customers ALTER COLUMN last_name TYPE varchar(200)`,
      // Widen zip for international formats
      `ALTER TABLE orders ALTER COLUMN zip TYPE varchar(30)`,
      `ALTER TABLE customers ALTER COLUMN zip TYPE varchar(30)`,
      `ALTER TABLE partners ALTER COLUMN zip TYPE varchar(30)`,
    ];

    for (const stmt of alterStatements) {
      try {
        await pool.query(stmt);
        results.push(`OK: ${stmt}`);
      } catch (err: any) {
        results.push(`SKIP: ${stmt} – ${err.message}`);
      }
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
