/**
 * Label Router – DHL shipping label upload, storage, and tracking extraction
 *
 * Tracking extraction strategy (in order):
 *   1. pdftotext (poppler-utils) – fast, exact, works on all DHL PDFs
 *   2. Regex on raw base64 text – fallback for text-layer PDFs
 *   3. LLM Vision (Forge API) – last resort for image-only PDFs
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, adminProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { orders } from "../drizzle/schema.js";
import { ENV } from "./env.js";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ─── Tracking number extraction ───────────────────────────────────────────────

/**
 * DHL tracking numbers:
 *  - Express/Paket: 12 digits starting with 00340 (JD-number) or 1Z…
 *  - Standard: 20 digits starting with 00340
 *  - Also: "Sendungsnummer" followed by the number
 */
const TRACKING_PATTERNS = [
  // DHL Paket: 20-digit barcode starting with 00340
  /\b(00340\d{15})\b/g,
  // DHL Express JD number
  /\b(JD\d{18})\b/gi,
  // Generic DHL: 12-20 digits starting with 00
  /\b(00[0-9]{10,18})\b/g,
  // "Sendungsnummer" label followed by number
  /Sendungsnummer[:\s]+([A-Z0-9]{10,30})/gi,
  // "Tracking" label
  /Tracking[:\s#-]+([A-Z0-9]{10,30})/gi,
  // PAK-ID pattern (seen in DHL labels)
  /PAK-ID:\s*([A-Z0-9\s]{10,30})/gi,
];

function extractTrackingFromText(text: string): string | null {
  for (const pattern of TRACKING_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      const num = match[1].replace(/\s+/g, "").trim();
      if (num.length >= 10) return num;
    }
  }
  return null;
}

/**
 * Method 1: Use pdftotext (poppler-utils) to extract text from PDF base64
 */
function extractViaPoppler(pdfBase64: string): string | null {
  const tmpPdf = join(tmpdir(), `label_${Date.now()}.pdf`);
  try {
    writeFileSync(tmpPdf, Buffer.from(pdfBase64, "base64"));
    const text = execSync(`pdftotext "${tmpPdf}" -`, {
      timeout: 8000,
      encoding: "utf8",
    });
    console.log("[labelRouter] pdftotext output:", text.substring(0, 500));
    return extractTrackingFromText(text);
  } catch (err: any) {
    console.warn("[labelRouter] pdftotext failed:", err.message);
    return null;
  } finally {
    if (existsSync(tmpPdf)) unlinkSync(tmpPdf);
  }
}

/**
 * Method 2: Regex scan on raw base64 decoded text (catches embedded text in PDF)
 */
function extractViaRawText(pdfBase64: string): string | null {
  try {
    const raw = Buffer.from(pdfBase64, "base64").toString("latin1");
    return extractTrackingFromText(raw);
  } catch {
    return null;
  }
}

/**
 * Method 3: LLM Vision fallback (Forge API)
 */
async function extractViaLLM(
  imageBase64: string,
  mimeType: string
): Promise<string | null> {
  if (!ENV.forgeApiKey) return null;
  try {
    const response = await fetch(`${ENV.forgeApiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.forgeApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${imageBase64}` },
              },
              {
                type: "text",
                text: 'This is a DHL shipping label. Extract ONLY the tracking/shipment number (Sendungsnummer). It is typically a long number starting with 00340 or similar. Reply with ONLY the number, nothing else. If not found, reply "NOT_FOUND".',
              },
            ],
          },
        ],
      }),
    });
    const data = await response.json() as any;
    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    console.log("[labelRouter] LLM response:", text);
    if (text && text !== "NOT_FOUND" && text.length >= 10) {
      return text.replace(/\s+/g, "");
    }
    return null;
  } catch (err: any) {
    console.warn("[labelRouter] LLM extraction failed:", err.message);
    return null;
  }
}

/**
 * Main extraction function – tries all methods in order
 */
async function extractTrackingNumber(
  base64Data: string,
  mimeType: string
): Promise<{ trackingNumber: string | null; method: string }> {
  // Method 1: pdftotext (only for PDFs)
  if (mimeType === "application/pdf") {
    const result = extractViaPoppler(base64Data);
    if (result) {
      console.log("[labelRouter] Tracking extracted via pdftotext:", result);
      return { trackingNumber: result, method: "pdftotext" };
    }

    // Method 2: Raw text scan (only for PDFs)
    const rawResult = extractViaRawText(base64Data);
    if (rawResult) {
      console.log("[labelRouter] Tracking extracted via raw text:", rawResult);
      return { trackingNumber: rawResult, method: "raw-text" };
    }
  }

  // Method 3: LLM Vision (for images and PDF-as-image fallback)
  const llmResult = await extractViaLLM(base64Data, mimeType);
  if (llmResult) {
    console.log("[labelRouter] Tracking extracted via LLM:", llmResult);
    return { trackingNumber: llmResult, method: "llm" };
  }

  return { trackingNumber: null, method: "none" };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const labelRouter = router({
  /**
   * Upload a label (PDF or image) and automatically extract the tracking number.
   * Returns the tracking number so the frontend can immediately use it.
   */
  uploadLabel: adminProcedure
    .input(
      z.object({
        orderId: z.string(),
        imageBase64: z.string(),
        mimeType: z.string().default("image/png"),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.orderId, input.orderId))
        .limit(1);
      if (!order) throw new Error("Bestellung nicht gefunden");

      // Store label as data URL
      const dataUrl = `data:${input.mimeType};base64,${input.imageBase64}`;
      await db
        .update(orders)
        .set({ shippingLabelUrl: dataUrl })
        .where(eq(orders.orderId, input.orderId));

      // Extract tracking number
      const { trackingNumber, method } = await extractTrackingNumber(
        input.imageBase64,
        input.mimeType
      );

      // If tracking found, save it immediately
      if (trackingNumber) {
        await db
          .update(orders)
          .set({
            trackingNumber,
            trackingCarrier: "DHL",
          })
          .where(eq(orders.orderId, input.orderId));
      }

      return {
        success: true,
        url: dataUrl,
        trackingNumber: trackingNumber || null,
        trackingCarrier: trackingNumber ? "DHL" : null,
        extractionMethod: method,
      };
    }),

  // Get label for an order
  getLabel: adminProcedure
    .input(z.object({ orderId: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [order] = await db
        .select({ shippingLabelUrl: orders.shippingLabelUrl })
        .from(orders)
        .where(eq(orders.orderId, input.orderId))
        .limit(1);

      return { url: order?.shippingLabelUrl || null };
    }),
});
