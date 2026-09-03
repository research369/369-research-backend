import { z } from "zod";
import { publicProcedure, router } from "./trpc.js";
import { LADYPEPS_CONTRACT_VERSION, getLadypepsProductPolicy } from "./ladypepsChannelPolicy.js";

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
});

