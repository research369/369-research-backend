export type AgentChannel = "whatsapp" | "web" | "wawi" | "api" | "unknown";

export type AgentMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentRunContext = {
  tenantId: string;
  channel: AgentChannel;
  conversationId?: string;
  customerId?: string;
  locale?: string;
  history?: AgentMessage[];
  metadata?: Record<string, unknown>;
};

export type AgentRequest = {
  message: string;
  context: AgentRunContext;
};

export type AgentEvent =
  | {
      type: "agent.request.sent";
      agentId: string;
      provider: string;
      model: string;
      tenantId: string;
      conversationId?: string;
      at: string;
    }
  | {
      type: "agent.response.received";
      agentId: string;
      provider: string;
      model: string;
      tenantId: string;
      conversationId?: string;
      responseId?: string;
      at: string;
    };

export type AgentResponse = {
  agentId: string;
  provider: string;
  model: string;
  text: string;
  responseId?: string;
};

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

export interface Agent {
  readonly id: string;
  readonly tenantIds: readonly string[];
  run(request: AgentRequest): Promise<AgentResponse>;
}
