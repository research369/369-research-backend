import { z } from "zod";
import { router, adminProcedure } from "./trpc.js";
import { listAdminChanges } from "./adminChangeLogService.js";

const sourceSchema = z.enum([
  "admin_input",
  "product",
  "stock",
  "template",
  "kwk",
]);

/** Read-only admin history. Values from customer/contact/message inputs are never returned. */
export const adminChangeLogRouter = router({
  recent: adminProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(80),
          source: sourceSchema.optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const changes = await listAdminChanges({
        limit: input?.limit ?? 80,
        source: input?.source,
      });
      return changes.map((change) => ({
        ...change,
        createdAt: change.createdAt.toISOString(),
      }));
    }),
});
