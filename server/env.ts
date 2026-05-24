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

  // Forge LLM API (for KI-Bestellerfassung)
  forgeApiKey: process.env.FORGE_API_KEY || "",
  forgeApiUrl: process.env.FORGE_API_URL || "https://forge.manus.ai",

  // Admin credentials (set via env vars)
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "",

  // Internal API key for WaWi frontend calls (no user login required)
  wawiInternalKey: process.env.WAWI_INTERNAL_KEY || "",

  // Sendcloud API (shipping labels)
  sendcloudPublicKey: process.env.SENDCLOUD_PUBLIC_KEY || "",
  sendcloudSecretKey: process.env.SENDCLOUD_SECRET_KEY || "",
  sendcloudWebhookSecret: process.env.SENDCLOUD_WEBHOOK_SECRET || "",
  sendcloudShipmentIdDe: process.env.SENDCLOUD_SHIPMENT_ID_DE || "8",
  sendcloudShipmentIdEu: process.env.SENDCLOUD_SHIPMENT_ID_EU || "8",

  // Sender address for labels (Core Versand & Logistik)
  senderName: process.env.SENDER_NAME || "Core Versand & Logistik",
  senderStreet: process.env.SENDER_STREET || "",
  senderHouseNumber: process.env.SENDER_HOUSE_NUMBER || "",
  senderCity: process.env.SENDER_CITY || "",
  senderZip: process.env.SENDER_ZIP || "",
  senderCountry: process.env.SENDER_COUNTRY || "DE",
};
