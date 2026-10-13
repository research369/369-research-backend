import {
  calculateAuthoritativeShipping,
  resolveShippingRegion,
  requiresColdChainShipping,
} from "./kwkCheckoutPricing.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { articles, partners, customers } from "../drizzle/schema.js";
import { getDb, getPool, withReadOnlyDatabase } from "./db.js";
import { getPublicShopVariants } from "./articleRouter.js";
import { orderRouter } from "./orderRouter.js";
import {
  extractDosageMg,
  isSubstitutionEnabled,
  isSubstitutionEligible,
  resolveSubstitution,
} from "./substitutionService.js";
import type { Request, Response } from "express";
export const simulationSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            articleId: z.number().int().positive(),
            sku: z.string().min(1).max(50),
            shopProductId: z.string().min(1).max(100),
            variantKey: z.string().max(100),
            quantity: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    country: z.string().min(2).max(100),
    discountCode: z.string().max(80).optional(),
    partnerCode: z.string().max(80).optional(),
    partnerId: z.number().int().positive().optional(),
    creditUsed: z.number().min(0).max(100000).default(0),
    customerId: z.number().int().positive().optional(),
    contact: z
      .object({
        email: z.string().email().max(320),
        phone: z.string().max(50).default(""),
      })
      .strict()
      .optional(),
    kwkCode: z.string().max(80).optional(),
    kwkCreditUsed: z.number().min(0).max(100000).default(0),
  })
  .strict();
export async function simulateCheckout(
  body: unknown,
  req: Request,
  res: Response,
) {
  const i = simulationSchema.parse(body);
  return withReadOnlyDatabase(async () => {
    const db = await getDb();
    if (!db) throw Error("unavailable");
    const inventory = await db.select().from(articles);
    const mutable = inventory
      .filter((a) => a.isActive === 1)
      .map((a) => ({ ...a }));
    const substitutionEnabled = await isSubstitutionEnabled();
    const stockPlan: any[] = [];
    const items = i.items.map((line) => {
      const family = inventory.filter(
        (a) =>
          a.shopProductId === line.shopProductId &&
          a.isActive === 1 &&
          a.shopVisible === 1,
      );
      if (family.length !== 1) throw Error("identity_ambiguous");
      const variants = getPublicShopVariants(family[0], inventory);
      const v = variants.filter(
        (v) =>
          v.articleId === line.articleId &&
          v.sku === line.sku &&
          v.dosage === line.variantKey,
      );
      if (v.length !== 1 || v[0].hidden) throw Error("identity_mismatch");
      const target = mutable.find(
        (a) =>
          a.id === line.articleId && a.sku === line.sku && a.isActive === 1,
      );
      if (!target) throw Error("identity_mismatch");
      if (target.stock >= line.quantity) {
        target.stock -= line.quantity;
        stockPlan.push({
          requestedSku: line.sku,
          available: true,
          substitution: false,
          components: [
            { articleId: target.id, sku: target.sku, quantity: line.quantity },
          ],
        });
      } else {
        const dose = extractDosageMg(line.variantKey);
        const plan =
          substitutionEnabled && isSubstitutionEligible(target.category) && dose
            ? resolveSubstitution(
                line.shopProductId,
                dose,
                line.quantity,
                mutable,
              )
            : null;
        if (plan?.possible) {
          for (const c of plan.components)
            mutable.find((a) => a.id === c.articleId)!.stock -= c.quantity;
          stockPlan.push({
            requestedSku: line.sku,
            available: true,
            substitution: true,
            components: plan.components.map((c) => ({
              articleId: c.articleId,
              sku: c.sku,
              quantity: c.quantity,
            })),
          });
        } else
          stockPlan.push({
            requestedSku: line.sku,
            available: false,
            substitution: false,
            components: [],
          });
      }
      return {
        name: family[0].name,
        dosage: line.variantKey,
        variant: line.variantKey,
        price: v[0].price,
        quantity: line.quantity,
        type: "peptide",
        shopProductId: line.shopProductId,
      };
    });
    const partner = i.partnerId
      ? (
          await db
            .select()
            .from(partners)
            .where(eq(partners.id, i.partnerId))
            .limit(1)
        )[0]
      : null;
    if (i.partnerId && !partner) throw Error("partner_not_found");
    if (i.creditUsed > 0 && !partner) throw Error("partner_required");
    const known = i.customerId
      ? (
          await db
            .select()
            .from(customers)
            .where(eq(customers.id, i.customerId))
            .limit(1)
        )[0]
      : null;
    if (i.customerId && !known) throw Error("Kunde nicht gefunden.");
    if (i.kwkCode && !known && !i.contact)
      throw Error(
        "Für die KWK-Neukundenprüfung bitte einen Kunden oder dessen Kontakt angeben.",
      );
    if (partner && known)
      throw Error(
        "Partner-Selbstbestellung und Kundenauswahl sind getrennte Fälle.",
      );
    const customer = partner
      ? {
          firstName: partner.name,
          lastName: "",
          email: partner.email,
          phone: partner.phone || "",
          street: partner.street || "",
          houseNumber: partner.houseNumber || "",
          zip: partner.zip || "",
          city: partner.city || "",
          country: partner.country || i.country,
        }
      : known
        ? {
            firstName: known.firstName || known.name,
            lastName: known.lastName || "",
            email: known.email,
            phone: known.phone || "",
            street: known.street || "",
            houseNumber: known.houseNumber || "",
            zip: known.zip || "",
            city: known.city || "",
            country: i.country,
          }
        : {
            firstName: "",
            lastName: "",
            email: i.contact?.email ?? null,
            phone: i.contact?.phone ?? "",
            street: "",
            houseNumber: "",
            zip: "",
            city: "",
            country: i.country,
          };
    let kwkCreditAccountId: number | undefined;
    if (i.kwkCreditUsed > 0) {
      if (!known?.email)
        throw Error(
          "Für KWK-Guthaben bitte einen gespeicherten Kunden mit E-Mail auswählen.",
        );
      const pool = await getPool();
      const accounts = (
        await pool!.query(
          "SELECT id FROM kwk_accounts WHERE lower(trim(email))=$1 AND status='aktiv' AND deleted_at IS NULL LIMIT 2",
          [known.email.trim().toLowerCase()],
        )
      ).rows;
      if (accounts.length !== 1)
        throw Error("Kein eindeutig zugeordnetes aktives KWK-Konto.");
      kwkCreditAccountId = accounts[0].id;
    }
    const result = await orderRouter
      .createCaller({
        req,
        res,
        user: null,
        operationsPreview: { partnerId: i.partnerId, kwkCreditAccountId },
      })
      .create({
        items,
        customer,
        subtotal: items.reduce((n, l) => n + l.price * l.quantity, 0),
        discount: 0,
        discountCode: i.discountCode || null,
        partnerCode: i.partnerCode || null,
        partnerNumber: partner?.partnerNumber || undefined,
        creditUsed: i.creditUsed,
        kwkCode: i.kwkCode || null,
        kwkCreditUsed: i.kwkCreditUsed,
        shipping: calculateAuthoritativeShipping({
          country: customer.country,
          items,
        }),
        shippingCountry: resolveShippingRegion(customer.country),
        total: 0,
        paymentMethod: "SEPA",
        date: new Date().toISOString(),
      });
    return {
      ...(result as any).operationsPreview,
      stockPlan,
      shippingDetails: {
        region: resolveShippingRegion(customer.country),
        cooled: items.some(requiresColdChainShipping),
        free: (result as any).operationsPreview.shipping === 0,
      },
      available: stockPlan.every((p) => p.available),
      checkedAt: new Date().toISOString(),
      limitations: [
        "Die Vorschau prüft Preis, Bestand und gegebenenfalls Kundenvoraussetzungen. Die Lieferadressprüfung verwendet denselben Dienst wie die tatsächliche Bestellung; Hinweise müssen im Shop vor dem Bestellen bestätigt werden.",
        "Guthaben werden nur geprüft und nicht reserviert. Eine echte Einlösung erfordert die persönliche Anmeldung im Shop.",
      ],
      sideEffects: false,
    };
  });
}
