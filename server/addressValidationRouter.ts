import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { router, adminProcedure, publicProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { addressValidationRecords, orders } from "../drizzle/schema.js";
import { persistAddressValidation, validateGermanAddress } from "./addressValidationService.js";

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

  // Vor der automatischen DHL-Erstellung wird immer die tatsächlich gespeicherte
  // Lieferadresse der Bestellung geprüft und als unveränderbarer Nachweis abgelegt.
  validateForShipment: adminProcedure.input(z.object({ orderId: z.string().min(1) })).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Datenbank für DHL-Adressprüfung nicht verfügbar");
    const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
    if (!order) throw new Error(`Bestellung ${input.orderId} nicht gefunden`);

    const address = {
      street: order.street || "",
      houseNumber: order.houseNumber || "",
      zip: order.zip || "",
      city: order.city || "",
      country: order.country || order.shippingCountry || "Deutschland",
      deliveryType: ((order as any).deliveryType === "packstation" ? "packstation" : "home") as "home" | "packstation",
    };
    const result = await validateGermanAddress(address);
    await persistAddressValidation({
      input: address,
      result,
      context: "shipping_automation",
      customerId: order.customerId ?? null,
      orderId: order.orderId,
      confirmedBy: (ctx as any).user?.username || "WaWi-Automation",
    });
    return result;
  }),

  /**
   * Bewusster Ausnahmeweg für eine im Packprozess fachlich geprüfte Lieferadresse.
   * Die eigentliche Prüfwarnung, der Bearbeiter und ein unveränderbarer Nachweis
   * werden gespeichert. Der nachfolgende DHL-Ablauf darf nur nach dieser Aktion
   * die erneute Warnung für genau diesen Abschluss überspringen.
   */
  confirmShipmentAddressOverride: adminProcedure.input(z.object({ orderId: z.string().min(1) })).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Datenbank für DHL-Adressprüfung nicht verfügbar");
    const [order] = await db.select().from(orders).where(eq(orders.orderId, input.orderId)).limit(1);
    if (!order) throw new Error(`Bestellung ${input.orderId} nicht gefunden`);

    const address = {
      street: order.street || "",
      houseNumber: order.houseNumber || "",
      zip: order.zip || "",
      city: order.city || "",
      country: order.country || order.shippingCountry || "Deutschland",
      deliveryType: ((order as any).deliveryType === "packstation" ? "packstation" : "home") as "home" | "packstation",
    };
    const result = await validateGermanAddress(address);
    const confirmedBy = (ctx as any).user?.name || (ctx as any).user?.username || "Master-Admin";
    await persistAddressValidation({
      input: address,
      result,
      context: "shipping_automation",
      customerId: order.customerId ?? null,
      orderId: order.orderId,
      overrideConfirmed: true,
      confirmedBy,
    });
    return { ...result, overrideConfirmed: true, overrideConfirmedBy: confirmedBy };
  }),

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
