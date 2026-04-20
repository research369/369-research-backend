/**
 * AI Router – LLM proxy for KI-Bestellerfassung
 * Routes LLM calls through the Railway backend so the API key stays server-side
 * Uses publicProcedure with an internal API key check (no user login required)
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "./trpc.js";
import { ENV } from "./env.js";

// Internal API key for WaWi frontend calls (no user login required)
// Must match WAWI_INTERNAL_KEY env var on Railway
const WAWI_INTERNAL_KEY = process.env.WAWI_INTERNAL_KEY || "";

export const aiRouter = router({
  /**
   * Proxy LLM chat completion requests through the backend
   * Used by the KI-Bestellerfassung to extract order data from screenshots
   * Secured by internal API key (WAWI_INTERNAL_KEY) instead of user auth
   */
  chatCompletion: publicProcedure
    .input(
      z.object({
        internalKey: z.string().optional(),
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
    .mutation(async ({ input, ctx }) => {
      // Check internal API key OR valid user session
      const hasValidKey = WAWI_INTERNAL_KEY && input.internalKey === WAWI_INTERNAL_KEY;
      const hasValidUser = !!ctx.user;

      if (!hasValidKey && !hasValidUser) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Kein gültiger API-Key oder Login",
        });
      }

      const apiKey = ENV.forgeApiKey;
      const baseUrl = ENV.forgeApiUrl;

      if (!apiKey) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "FORGE_API_KEY not configured on server",
        });
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
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `LLM API Error (${response.status}): ${errorText}`,
        });
      }

      const data = await response.json();
      return data;
    }),
});
