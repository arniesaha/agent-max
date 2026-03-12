import { AgentWeaveConfig, traceTool, withSpan } from "agentweave";
import { PROV_ACTIVITY_TYPE, ACTIVITY_AGENT_TURN, PROV_AGENT_ID, PROV_WAS_ASSOCIATED_WITH } from "agentweave";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { log } from "./logger.js";

/**
 * Initialize AgentWeave tracing. Call once at startup before agent creation.
 */
export function initTracing() {
  const endpoint = process.env.AGENTWEAVE_OTLP_ENDPOINT;
  if (!endpoint) {
    log("info", "AgentWeave tracing disabled (AGENTWEAVE_OTLP_ENDPOINT not set)");
    return;
  }

  AgentWeaveConfig.setup({
    agentId: "max-v1",
    agentModel: process.env.DEFAULT_MODEL || "gemini-2.5-pro",
    otlpEndpoint: `${endpoint}/v1/traces`,
    capturesInput: false,
    capturesOutput: false,
  });

  log("info", `AgentWeave tracing enabled → ${endpoint}`);
}

/**
 * Wrap an AgentTool's execute function with a traceTool span.
 * Preserves the original tool definition, only wrapping execute.
 */
function wrapToolExecute(tool: AgentTool): AgentTool {
  if (!AgentWeaveConfig.enabled) return tool;

  const traced = traceTool(tool.name)(tool.execute);
  return { ...tool, execute: traced };
}

/**
 * Wrap all tools in an array with tracing spans.
 */
export function traceTools(tools: AgentTool[]): AgentTool[] {
  if (!AgentWeaveConfig.enabled) return tools;
  return tools.map(wrapToolExecute);
}

/**
 * Run an async function inside an agent turn span.
 */
export function traceAgentTurn<T>(name: string, fn: () => T | Promise<T>): T | Promise<T> {
  if (!AgentWeaveConfig.enabled) return fn();
  return withSpan(`agent.${name}`, {
    [PROV_ACTIVITY_TYPE]: ACTIVITY_AGENT_TURN,
    [PROV_AGENT_ID]: "max-v1",
    [PROV_WAS_ASSOCIATED_WITH]: "max-v1",
  }, () => fn());
}
