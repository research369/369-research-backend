/**
 * Label Router – DHL shipping label upload and storage
 * Simplified: Frontend does the cropping, backend just stores the result
 * No Manus LLM/S3 dependency – stores base64 directly in DB or returns it
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { orders } from "../drizzle/schema.js";

export const labelRouter = router({
  // Upload a cropped label image (base64) and store the URL in the order
  uploadLabel: adminProcedure
    .input(z.object({
      orderId: z.string(),
      imageBase64: z.string(), // Base64-encoded image (PNG/JPEG from frontend canvas)
      mimeType: z.string().default("image/png"),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Verify order exists
      const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      // Store as data URL directly in the database
      const dataUrl = `data:${input.mimeType};base64,${input.imageBase64}`;

      await db.update(orders).set({
        shippingLabelUrl: dataUrl,
      }).where(eq(orders.orderId, input.orderId));

      return { success: true, url: dataUrl };
    }),

  // Get label for an order
  getLabel: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [order] = await db.select({
        shippingLabelUrl: orders.shippingLabelUrl,
      }).from(orders).where(eq(orders.orderId, input.orderId)).limit(1);

      return { url: order?.shippingLabelUrl || null };
    }),
});
