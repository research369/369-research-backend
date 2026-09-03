import { z } from "zod";
import { publicProcedure, router } from "./trpc.js";
import { LADYPEPS_CONTRACT_VERSION, getLadypepsProductPolicy } from "./ladypepsChannelPolicy.js";
import { getDb } from "./db.js";
import { articles } from "../drizzle/schema.js";
import { calculateAuthoritativeShipping, requiresColdChainShipping, resolveAuthoritativeItemPrice, roundMoney } from "./kwkCheckoutPricing.js";

const productForm = z.enum(["base_vial", "diy_nasal", "finished_nasal", "plug_play", "mix_and_go"]);

const quoteInput = z.object({
  shippingCountry: z.string().trim().min(2).max(80),
  items: z.array(z.object({
    productId: z.string().trim().min(1).max(120),
    dosage: z.string().trim().max(80).optional(),
    quantity: z.number().int().min(1).max(20),
    form: productForm,
  })).min(1).max(30),
});

function formToCommerceFlags(form: z.infer<typeof productForm>) {
  return {
    isNasalSpray: form === "finished_nasal",
    isNasalDiySet: form === "diy_nasal",
    isPlugPlay: form === "plug_play",
    isFinishedNasal: form === "finished_nasal",
  };
}

export const ladypepsChannelRouter = router({
  contract: publicProcedure.query(() => ({
    channel: "ladypeps" as const,
    version: LADYPEPS_CONTRACT_VERSION,
  })),
  productForms: publicProcedure
    .input(z.object({ productId: z.string().trim().min(1).max(120) }))
    .query(({ input }) => ({
      channel: "ladypeps" as const,
      version: LADYPEPS_CONTRACT_VERSION,
      policy: getLadypepsProductPolicy(input.productId),
    })),
  quote: publicProcedure
    .input(quoteInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");

      const catalog = await db.select({
        sku: articles.sku,
        shopProductId: articles.shopProductId,
        name: articles.name,
        sellingPrice: articles.sellingPrice,
        salePrice: articles.salePrice,
        variants: articles.variants,
        isActive: articles.isActive,
        shopVisible: articles.shopVisible,
      }).from(articles);

      const items = input.items.map((inputItem) => {
        const policy = getLadypepsProductPolicy(inputItem.productId);
        if (!policy) throw new Error(`Produkt ist für LADYPEPS nicht freigegeben: ${inputItem.productId}`);
        const formPolicy = policy.forms.find((form) => form.form === inputItem.form);
        if (!formPolicy || formPolicy.approval !== "enabled") {
          throw new Error(`Produktform ist für ${inputItem.productId} nicht freigegeben`);
        }

        const flags = formToCommerceFlags(inputItem.form);
        const price = resolveAuthoritativeItemPrice({
          shopProductId: inputItem.productId,
          price: 0,
          quantity: inputItem.quantity,
          dosage: inputItem.dosage,
          ...flags,
        }, catalog);

        return {
          productId: inputItem.productId,
          dosage: inputItem.dosage,
          quantity: inputItem.quantity,
          form: inputItem.form,
          name: policy.productId,
          price,
          ...flags,
          requiresColdChain: formPolicy.requiresColdChain,
          includedComponents: formPolicy.includedComponents,
          fulfillmentFlags: formPolicy.fulfillmentFlags,
        };
      });

      const subtotal = roundMoney(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
      const shipping = calculateAuthoritativeShipping({ country: input.shippingCountry, items });
      return {
        channel: "ladypeps" as const,
        version: LADYPEPS_CONTRACT_VERSION,
        currency: "EUR" as const,
        items,
        subtotal,
        discount: 0,
        shipping,
        total: roundMoney(subtotal + shipping),
        hasColdChain: items.some(requiresColdChainShipping),
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
    }),
});
