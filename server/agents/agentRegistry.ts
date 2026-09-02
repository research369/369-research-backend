import type { Agent, AgentEventSink } from "./types.js";
import { PepGptAgent } from "./pepGptAgent.js";

export class AgentRegistry {
  private readonly agents: Agent[];

  constructor(eventSink?: AgentEventSink) {
    this.agents = [new PepGptAgent(eventSink)];
  }

  resolveForTenant(tenantId: string): Agent {
    const normalized = tenantId.trim().toLowerCase();
    const agent = this.agents.find((candidate) =>
      candidate.tenantIds.some((id) => id.toLowerCase() === normalized)
    );

    if (!agent) {
      throw new Error(`No agent configured for tenant: ${tenantId}`);
    }

    return agent;
  }
}
