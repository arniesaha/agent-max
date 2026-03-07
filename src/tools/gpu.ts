import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { delegateToNix } from "./nix-relay.js";

export const wakeGpu: AgentTool = {
  name: "wake_gpu",
  label: "Wake GPU PC",
  description: "Wake the GPU PC via Nix (NAS agent has direct network access to the GPU PC)",
  parameters: Type.Object({}),
  execute: async (_id, _params, signal) => {
    return delegateToNix.execute("wake_gpu", { task: "Wake the GPU PC and confirm when Ollama is online.", skill_id: "general" }, signal);
  },
};

export const shutdownGpu: AgentTool = {
  name: "shutdown_gpu",
  label: "Shutdown GPU PC",
  description: "Gracefully shutdown the GPU PC via Nix (NAS agent has direct network access to the GPU PC)",
  parameters: Type.Object({}),
  execute: async (_id, _params, signal) => {
    return delegateToNix.execute("shutdown_gpu", { task: "Shutdown the GPU PC gracefully.", skill_id: "general" }, signal);
  },
};

export const gpuStatus: AgentTool = {
  name: "gpu_status",
  label: "GPU Status",
  description: "Check if GPU PC is online via Nix (NAS agent has direct network access to the GPU PC)",
  parameters: Type.Object({}),
  execute: async (_id, _params, signal) => {
    return delegateToNix.execute("gpu_status", { task: "Check if the GPU PC is online and report Ollama status.", skill_id: "general" }, signal);
  },
};
