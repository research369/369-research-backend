/**
 * AI Router – LLM proxy for KI-Bestellerfassung
 * Routes LLM calls through the Railway backend so the API key stays server-side
 */
import { z } from "zod";
import { protectedProcedure, router } from "./trpc.js";
import { ENV } from "./env.js";

export const aiRouter = router({
  /**
   * Proxy LLM chat completion requests through the backend
   * Used by the KI-Bestellerfassung to extract order data from screenshots
   */
  chatCompletion: protectedProcedure
    .input(
      z.object({
        messages: z.array(
          z.object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.union([
              z.string(),
              z.array(z.any()),
            ]),
          })
        ),
        response_format: z.any().optional(),
        temperature: z.number().optional().default(0.1),
        max_tokens: z.number().optional().default(4096),
      })
    )
    .mutation(async ({ input }) => {
      const apiKey = ENV.forgeApiKey;
      const baseUrl = ENV.forgeApiUrl;

      if (!apiKey) {
        throw new Error("FORGE_API_KEY not configured on server");
      }

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          messages: input.messages,
          response_format: input.response_format,
          temperature: input.temperature,
          max_tokens: input.max_tokens,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API Error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      return data;
    }),
});
