import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "./trpc.js";
import { AgentRegistry } from "./agents/agentRegistry.js";
import type { AgentEvent } from "./agents/types.js";

function logAgentEvent(event: AgentEvent): void {
  console.info(JSON.stringify({ scope: "agent", ...event }));
}

const registry = new AgentRegistry(logAgentEvent);

const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

export const agentRouter = router({
  run: publicProcedure
    .input(
      z.object({
        internalKey: z.string().optional(),
        tenantId: z.string().min(1),
        channel: z.enum(["whatsapp", "web", "wawi", "api", "unknown"]).default("api"),
        message: z.string().min(1),
        conversationId: z.string().optional(),
        customerId: z.string().optional(),
        locale: z.string().optional(),
        history: z.array(historyMessageSchema).max(40).optional(),
        metadata: z.record(z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const configuredKey = process.env.PEPGPT_INTERNAL_KEY || process.env.WAWI_INTERNAL_KEY || "";
      const hasValidKey = configuredKey && input.internalKey === configuredKey;
      const hasValidUser = !!ctx.user;

      if (!hasValidKey && !hasValidUser) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Kein gültiger API-Key oder Login" });
      }

      try {
        const agent = registry.resolveForTenant(input.tenantId);
        return await agent.run({
          message: input.message,
          context: {
            tenantId: input.tenantId,
            channel: input.channel,
            conversationId: input.conversationId,
            customerId: input.customerId,
            locale: input.locale,
            history: input.history,
            metadata: input.metadata,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent execution failed";
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
      }
    }),
});
