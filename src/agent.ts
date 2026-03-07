import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, getEnvApiKey, type Message } from "@mariozechner/pi-ai";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { loadMemory } from "./memory.js";
import { wakeGpu, shutdownGpu, gpuStatus } from "./tools/gpu.js";
import { readFileTool, writeFileTool, listFilesTool } from "./tools/fs.js";
import { sshToNas } from "./tools/ssh.js";
import { delegateToNix } from "./tools/nix-relay.js";
import { browserControl } from "./tools/browser.js";
import { linkedinSearch, linkedinResults } from "./tools/linkedin.js";
import { iosListDevices, iosBuild, iosInstall, iosBuildAndDeploy } from "./tools/ios-deploy.js";
import { launchpadRunScraper, launchpadDeploy } from "./tools/launchpad.js";
import { runShell } from "./tools/shell.js";
import { createContextInfoTool } from "./tools/context-info.js";
import { transformContext } from "./context.js";

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
  launchpadRunScraper, launchpadDeploy,
  // Shell
  runShell,
];

export async function createAgent(): Promise<Agent> {
  const model = getModel("google", "gemini-2.5-pro");
  const systemPrompt = await loadMemory();

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: "medium",
      tools: staticTools, // context_info added after construction
      messages: [],
    },
    getApiKey: (provider) => getEnvApiKey(provider),
    transformContext,
  });

  // Add agent-bound tools
  const allTools = [...staticTools, createContextInfoTool(agent)];
  agent.state.tools = allTools;

  return agent;
}

export { staticTools as allTools };
