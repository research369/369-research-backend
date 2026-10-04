import { z } from "zod";
import { router, publicProcedure } from "./trpc.js";
import { getDb } from "./db.js";
import { customers } from "../drizzle/schema.js";
import {
  createCustomerDataChangeConfirmation,
  resolveCheckoutCustomerDataChange,
  type CheckoutCustomerIdentity,
} from "./customerDataChangeService.js";

const checkoutCustomerSchema = z.object({
  firstName: z.string().trim().max(200),
  lastName: z.string().trim().max(200),
  email: z.string().trim().email().optional().nullable().or(z.literal("")),
  phone: z.string().trim().max(50).optional().nullable(),
  company: z.string().trim().max(200).optional().nullable(),
  street: z.string().trim().max(300).optional().nullable(),
  houseNumber: z.string().trim().max(100).optional().nullable(),
  zip: z.string().trim().max(30).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  country: z.string().trim().max(100).optional().nullable(),
  dhlPostNumber: z.string().trim().max(20).optional().nullable(),
});

/**
 * The public endpoint only reveals that a customer-controlled confirmation is
 * needed. It deliberately returns neither a prior address nor other historical
 * personal data to the browser.
 */
export const customerDataChangeRouter = router({
  previewCheckoutChange: publicProcedure
    .input(z.object({ customer: checkoutCustomerSchema }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Datenbank nicht verfügbar");
      const allCustomers = await db.select().from(customers);
      const resolution = resolveCheckoutCustomerDataChange(
        allCustomers as unknown as Parameters<typeof resolveCheckoutCustomerDataChange>[0],
        input.customer as CheckoutCustomerIdentity,
      );

      if (resolution.kind !== "matched") {
        return {
          requiresConfirmation: false,
          matchState: resolution.kind === "conflict" ? "conflict" : resolution.reason,
          confirmationToken: null,
          expiresAt: null,
          changedFields: [] as string[],
        };
      }

      if (!resolution.requiresConfirmation) {
        return {
          requiresConfirmation: false,
          matchState: "matched",
          confirmationToken: null,
          expiresAt: null,
          changedFields: [] as string[],
        };
      }

      const confirmation = await createCustomerDataChangeConfirmation(db, resolution);
      return {
        requiresConfirmation: true,
        matchState: "matched",
        confirmationToken: confirmation.confirmationToken,
        expiresAt: confirmation.expiresAt.toISOString(),
        changedFields: resolution.changedFields,
      };
    }),
});
