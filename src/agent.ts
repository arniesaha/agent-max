import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, getEnvApiKey, streamSimple } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { loadMemory } from "./memory.js";
import { log } from "./logger.js";
import { wakeGpu, shutdownGpu, gpuStatus } from "./tools/gpu.js";
import { readFileTool, writeFileTool, listFilesTool } from "./tools/fs.js";
import { sshToNas } from "./tools/ssh.js";
import { delegateToNix } from "./tools/nix-relay.js";
import { browserControl } from "./tools/browser.js";
import { linkedinSearch, linkedinResults } from "./tools/linkedin.js";
import { iosListDevices, iosBuild, iosInstall, iosBuildAndDeploy } from "./tools/ios-deploy.js";
import { launchpadRunScraper, launchpadDeploy } from "./tools/launchpad.js";
import { launchpadScrape } from "./tools/launchpad-scrape.js";
import { browserTask } from "./tools/browser-task.js";
import { runShell } from "./tools/shell.js";
import { manageTodos } from "./tools/todo.js";
import { delegateToClaudeSubagent } from "./tools/claude-subagent.js";
import { createContextInfoTool } from "./tools/context-info.js";
import { transformContext } from "./context.js";
import { traceTools } from "./tracing.js";
import { restoreSession } from "./session.js";
import { checkPermission } from "./permissions.js";

const staticTools: AgentTool[] = [
  // GPU
  wakeGpu, shutdownGpu, gpuStatus,
  // File system
  readFileTool, writeFileTool, listFilesTool,
  // Remote
  sshToNas, delegateToNix,
  // Browser
  browserControl,
  // LinkedIn
  linkedinSearch, linkedinResults,
  // iOS
  iosListDevices, iosBuild, iosInstall, iosBuildAndDeploy,
  // Launchpad
  launchpadRunScraper, launchpadDeploy, launchpadScrape,
  // browser-use agentic tasks
  browserTask,
  // Shell
  runShell,
  // Todos
  manageTodos,
  // Claude Code delegation
  delegateToClaudeSubagent,
];

function inferProvider(modelId: string): "anthropic" | "google" {
  return modelId.startsWith("claude") ? "anthropic" : "google";
}

function createMuxModel(requestedModel: string) {
  const openAiBaseModel = getModel("openai" as any, "gpt-4.1-mini" as any);
  if (!openAiBaseModel) {
    throw new Error("OpenAI base model not found for Mux integration");
  }

  const muxBaseUrl = process.env.MUX_BASE_URL?.replace(/\/+$/, "");
  if (!muxBaseUrl) {
    throw new Error("MUX_BASE_URL is required when MUX_ENABLED=true");
  }

  const muxModel = {
    ...openAiBaseModel,
    id: requestedModel,
    provider: "openai",
    api: "openai-completions",
    baseUrl: muxBaseUrl,
  } as any;

  log("info", `Mux enabled: routing requested model ${requestedModel} via ${muxBaseUrl}`);
  return muxModel;
}

function createDefaultModel(defaultModel: string) {
  const provider = inferProvider(defaultModel);
  const model = getModel(provider as any, defaultModel as any);
  if (!model) throw new Error(`Model not found: ${provider}/${defaultModel}`);

  // Route API calls through AgentWeave observability proxy if configured
  if (provider === "anthropic" && process.env.ANTHROPIC_BASE_URL) {
    (model as any).baseUrl = process.env.ANTHROPIC_BASE_URL;
    log("info", `Anthropic base URL overridden to ${process.env.ANTHROPIC_BASE_URL}`);
  }
  if (provider === "google" && process.env.GOOGLE_GENAI_BASE_URL) {
    (model as any).baseUrl = `${process.env.GOOGLE_GENAI_BASE_URL}/v1beta`;
    log("info", `Google GenAI base URL overridden to ${(model as any).baseUrl}`);
  }

  return model;
}

export async function createAgent(): Promise<Agent> {
  const defaultModel = process.env.DEFAULT_MODEL || "gemini-2.5-pro";
  const muxEnabled = process.env.MUX_ENABLED === "true";
  const model = muxEnabled ? createMuxModel(defaultModel) : createDefaultModel(defaultModel);

  log("info", `Agent created with ${model.id}`);
  const systemPrompt = await loadMemory();

  // Wrap streamSimple to inject AgentWeave proxy auth + tracing header.
  // When using Mux, optionally send its API key as Authorization.
  // Only send AgentWeave proxy token for non-Mux paths to avoid colliding with Mux auth.
  const proxyToken = process.env.AGENTWEAVE_PROXY_TOKEN;
  const muxApiKey = process.env.MUX_API_KEY;
  const agentWeaveStreamFn: typeof streamSimple = (m, ctx, opts) =>
    streamSimple(m, ctx, {
      ...opts,
      headers: {
        ...opts?.headers,
        "X-AgentWeave-Agent-Id": "max-v1",
        "X-AgentWeave-Agent-Type": "main",
        "X-AgentWeave-Session-Id": "max-main",
        "X-AgentWeave-Project": "max",
        "X-Runtime": "agent-max",
        ...(muxEnabled && muxApiKey ? { Authorization: `Bearer ${muxApiKey}` } : {}),
        ...(!muxEnabled && proxyToken ? { "X-AgentWeave-Proxy-Token": proxyToken } : {}),
      },
    });

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: "medium",
      tools: staticTools, // context_info added after construction
      messages: [],
    },
    getApiKey: (provider) => {
      if (muxEnabled && provider === "openai") {
        return process.env.MUX_API_KEY || "mux-no-key";
      }
      return getEnvApiKey(provider);
    },
    transformContext,
    streamFn: agentWeaveStreamFn,
  });

  // Wrap tools with permission checks before tracing
  function withPermissionCheck(tool: AgentTool): AgentTool {
    const originalExecute = tool.execute;
    return {
      ...tool,
      execute: async (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: any) => {
        const result = await checkPermission(tool.name, params);
        if (!result.allowed) {
          log("warn", `Tool call denied: ${tool.name} — ${result.reason}`);
          return { content: [{ type: "text" as const, text: `Tool call denied: ${result.reason}` }], details: {} };
        }
        return originalExecute(toolCallId, params as any, signal, onUpdate);
      },
    };
  }

  // Add agent-bound tools, wrapped with permission checks and tracing spans
  const allTools = traceTools([...staticTools, createContextInfoTool(agent)].map(withPermissionCheck));
  agent.state.tools = allTools;

  // Restore previous session messages
  restoreSession(agent);

  return agent;
}

export { staticTools as allTools };
