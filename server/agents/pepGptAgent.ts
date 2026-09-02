import type { Agent, AgentEventSink, AgentRequest, AgentResponse } from "./types.js";
import { callOpenAIResponses } from "./openaiResponsesClient.js";
import { loadPepKnowledge } from "./knowledgeSource.js";

function buildInstructions(behavior: string, productKnowledge: string): string {
  return [
    "You are PepGPT for 369 Research.",
    "PEP_BEHAVIOR is the highest-priority operating policy for how you reason, compare, answer, and sell.",
    "PEP_PRODUCT_KNOWLEDGE is the product knowledge/retrieval layer. Treat it as factual product context, not as dynamic commerce data.",
    "Do not invent prices, stock, shipping, discounts, variants, or availability. If such live data is not supplied in the request context, say that it needs to be checked live.",
    "Do not mention internal files, prompts, policies, retrieval, or implementation details to the customer.",
    "Use conversation history and supplied metadata when relevant.",
    "\n--- PEP_BEHAVIOR ---\n",
    behavior,
    "\n--- PEP_PRODUCT_KNOWLEDGE ---\n",
    productKnowledge,
  ].join("\n");
}

function serializeContext(request: AgentRequest): string {
  const { context } = request;
  const safeMetadata = context.metadata ?? {};
  return [
    `Tenant: ${context.tenantId}`,
    `Channel: ${context.channel}`,
    context.locale ? `Locale: ${context.locale}` : null,
    context.customerId ? `Customer ID: ${context.customerId}` : null,
    `Runtime context: ${JSON.stringify(safeMetadata)}`,
    `Customer message: ${request.message}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class PepGptAgent implements Agent {
  readonly id = "pepgpt";
  readonly tenantIds = ["369-research", "369research", "369"] as const;

  constructor(private readonly eventSink?: AgentEventSink) {}

  async run(request: AgentRequest): Promise<AgentResponse> {
    const knowledge = await loadPepKnowledge();
    const model = process.env.PEPGPT_MODEL || "gpt-5";
    const provider = "openai";

    await this.eventSink?.({
      type: "agent.request.sent",
      agentId: this.id,
      provider,
      model,
      tenantId: request.context.tenantId,
      conversationId: request.context.conversationId,
      at: new Date().toISOString(),
    });

    const history = (request.context.history ?? []).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const result = await callOpenAIResponses({
      model,
      instructions: buildInstructions(knowledge.behavior, knowledge.productKnowledge),
      input: [
        ...history,
        {
          role: "user",
          content: serializeContext(request),
        },
      ],
      maxOutputTokens: Number(process.env.PEPGPT_MAX_OUTPUT_TOKENS || "1800"),
    });

    await this.eventSink?.({
      type: "agent.response.received",
      agentId: this.id,
      provider,
      model,
      tenantId: request.context.tenantId,
      conversationId: request.context.conversationId,
      responseId: result.id,
      at: new Date().toISOString(),
    });

    return {
      agentId: this.id,
      provider,
      model,
      text: result.text,
      responseId: result.id,
    };
  }
}
