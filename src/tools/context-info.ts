import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Agent } from "@mariozechner/pi-agent-core";
import { getContextStats } from "../context.js";

/** Creates a context info tool bound to the agent instance */
export function createContextInfoTool(agent: Agent): AgentTool {
  return {
    name: "context_info",
    label: "Context Info",
    description: "Get details about the current conversation context: token usage, message count, context window capacity, and compaction history.",
    parameters: Type.Object({}),
    execute: async () => {
      const stats = getContextStats(agent.state.messages);
      const lines = [
        `Context window: ${(stats.contextWindow / 1000).toFixed(0)}K tokens`,
        `Estimated usage: ~${(stats.totalTokens / 1000).toFixed(1)}K tokens (${stats.usagePercent}%)`,
        `Compact threshold: ${(stats.compactThreshold / 1000).toFixed(0)}K tokens (80%)`,
        `Messages: ${stats.messageCount}`,
        `Compactions so far: ${stats.compactions}`,
        `Model: ${agent.state.model.id}`,
        `Thinking: ${agent.state.thinkingLevel}`,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: stats,
      };
    },
  };
}
