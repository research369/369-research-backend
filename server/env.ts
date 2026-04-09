import "dotenv/config";

export const ENV = {
  databaseUrl: process.env.DATABASE_URL || "",
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  port: parseInt(process.env.PORT || "4000", 10),

  // CORS - Frontend URL(s)
  frontendUrl: process.env.FRONTEND_URL || "https://www.369research.eu",

  // Bunq
  bunqApiKey: process.env.BUNQ_API_KEY || "",

  // Resend (E-Mail)
  resendApiKey: process.env.RESEND_API_KEY || "",

  // Admin credentials (set via env vars)
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "",
};
