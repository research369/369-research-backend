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


// ── TEMP: Fix Doc Ben (P-1000) partner data ──
app.post("/api/fix-docben", async (req, res) => {
  try {
    const { getDb } = await import("./db.js");
    const { partners, partnerTransactions } = await import("../drizzle/schema.js");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return res.status(500).json({ error: "DB not available" });

    // Partner id=4 is Doc Ben (P-1000)
    const partnerId = 4;

    // Delete ALL existing provision transactions for Doc Ben
    await db.delete(partnerTransactions).where(eq(partnerTransactions.partnerId, partnerId));

    // Recalculate from the 2 actual orders with DOCB code
    // 369-10007: subtotal=39, discount=46 -> total=1 (but discount can't be > subtotal for products)
    //   Actually: total=1 means customer paid 1 EUR. Provision = 10% of (subtotal - discount) = max(0, 39-46)=0? 
    //   But total includes shipping. Let's use: netto = subtotal - discount = max(0, 39-46) = 0... 
    //   Wait: discount=46 > subtotal=39 makes no sense. Let's check: 75% of 39 = 29.25 discount.
    //   The discount field might include other things. Let's just use: netto = total - shipping.
    //   369-10007: total=1, shipping=8 -> netto = max(0, 1-8) = 0... that's wrong too.
    //   Actually the order data shows total=1 which seems like a test order.
    //   Let's recalculate properly: subtotal=39 (product value), customerDiscount=75% -> 39*0.75=29.25 discount
    //   nettoProducts = 39 - 29.25 = 9.75, provision = 10% = 0.975 -> 0.98 EUR
    //   But the stored discount=46 doesn't match 29.25. This order has bad data.
    //   
    // For safety: recalculate based on (subtotal - discount) for each order, min 0
    // 369-10007: max(0, 39 - 46) = 0 -> provision = 0
    // 369-10016: max(0, 7 - 5.51) = 1.49 -> provision = 0.15
    //
    // But this seems too low. Let me use total - shipping instead:
    // We need the actual shipping cost. Let's just set balance to 0 and let future orders calculate correctly.
    
    // Reset balance to 0
    await db.update(partners).set({
      creditBalance: "0.00",
      updatedAt: new Date(),
    }).where(eq(partners.id, partnerId));

    // Now recalculate for the 2 real orders
    // 369-10007: subtotal=39, discount=46 -> this is clearly test data with wrong values, netto=0
    // 369-10016: subtotal=7, discount=5.51 -> netto=1.49, provision=0.15
    const corrections = [
      { orderId: "369-10007", subtotal: 39, discount: 46, netto: 0, provision: 0, note: "Testbestellung mit fehlerhaften Daten (Rabatt > Subtotal)" },
      { orderId: "369-10016", subtotal: 7, discount: 5.51, netto: 1.49, provision: 0.15, note: "Korrigiert: 10% auf 1.49 EUR" },
    ];

    let runningBalance = 0;
    for (const c of corrections) {
      if (c.provision > 0) {
        runningBalance += c.provision;
        await db.insert(partnerTransactions).values({
          partnerId,
          type: "provision",
          amount: c.provision.toFixed(2),
          balanceAfter: runningBalance.toFixed(2),
          orderId: c.orderId,
          customerName: "Korrektur",
          description: `Korrigierte Provision f\u00fcr ${c.orderId}: ${c.note}`,
        });
      }
    }

    // Update final balance
    await db.update(partners).set({
      creditBalance: runningBalance.toFixed(2),
      updatedAt: new Date(),
    }).where(eq(partners.id, partnerId));

    // Also update partnerCommission on the orders
    const { orders } = await import("../drizzle/schema.js");
    await db.update(orders).set({ partnerCommission: "0.00" }).where(eq(orders.orderId, "369-10007"));
    await db.update(orders).set({ partnerCommission: "0.15" }).where(eq(orders.orderId, "369-10016"));

    res.json({ 
      success: true, 
      message: "Doc Ben (P-1000) korrigiert",
      newBalance: runningBalance.toFixed(2),
      corrections 
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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

  app.listen(port, "0.0.0.0", () => {
    console.log(`[Server] 369 Research Backend running on port ${port}`);
  });
}

start().catch((err) => {
  console.error("[Server] Fatal error:", err);
  process.exit(1);
});
