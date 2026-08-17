import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { router, adminProcedure, publicProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { addressValidationRecords } from "../drizzle/schema.js";
import { validateGermanAddress } from "./addressValidationService.js";

const addressSchema = z.object({
  street: z.string(),
  houseNumber: z.string(),
  zip: z.string(),
  city: z.string(),
  country: z.string(),
  deliveryType: z.enum(["home", "packstation"]).optional(),
});

function recordPreview(record: typeof addressValidationRecords.$inferSelect) {
  return {
    id: record.id,
    customerId: record.customerId,
    orderId: record.orderId,
    context: record.context,
    validationStatus: record.validationStatus,
    warnings: JSON.parse(record.warningsJson || "[]"),
    overrideConfirmed: record.overrideConfirmed === 1,
    overrideConfirmedAt: record.overrideConfirmedAt,
    overrideConfirmedBy: record.overrideConfirmedBy,
    hasEvidence: !!record.evidenceSvg,
    createdAt: record.createdAt,
  };
}

export const addressValidationRouter = router({
  validate: publicProcedure.input(addressSchema).query(async ({ input }) => validateGermanAddress(input)),

  recordsForCustomer: adminProcedure.input(z.object({ customerId: z.number() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new Error("Datenbank für Adressnachweise nicht verfügbar");
    const records = await db.select().from(addressValidationRecords)
      .where(eq(addressValidationRecords.customerId, input.customerId))
      .orderBy(desc(addressValidationRecords.createdAt));
    return records.map(recordPreview);
  }),

  recordsForOrder: adminProcedure.input(z.object({ orderId: z.string() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new Error("Datenbank für Adressnachweise nicht verfügbar");
    const records = await db.select().from(addressValidationRecords)
      .where(eq(addressValidationRecords.orderId, input.orderId))
      .orderBy(desc(addressValidationRecords.createdAt));
    return records.map(recordPreview);
  }),

  evidence: adminProcedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new Error("Datenbank für Adressnachweise nicht verfügbar");
    const [record] = await db.select().from(addressValidationRecords).where(eq(addressValidationRecords.id, input.id)).limit(1);
    if (!record || !record.evidenceSvg) throw new Error("Adressnachweis nicht vorhanden");
    return {
      id: record.id,
      svg: record.evidenceSvg,
      sha256: record.evidenceSha256,
      createdAt: record.createdAt,
    };
  }),
});
