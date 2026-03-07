import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const GPU_WOL_URL = process.env.GPU_WOL_URL || "http://localhost:9753/wake";
const GPU_HOST = process.env.GPU_HOST || "localhost";
const OLLAMA_URL = `http://${GPU_HOST}:11434`;

export const wakeGpu: AgentTool = {
  name: "wake_gpu",
  label: "Wake GPU PC",
  description: "Wake the GPU PC via Wake-on-LAN magic packet, then poll until Ollama is online",
  parameters: Type.Object({}),
  execute: async () => {
    try {
      await fetch(GPU_WOL_URL);
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to send WoL: ${e.message}` }], details: { success: false } };
    }

    // Poll for up to 90 seconds
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          return { content: [{ type: "text" as const, text: "GPU PC is online and Ollama is ready." }], details: { success: true } };
        }
      } catch {
        // Still booting
      }
    }
    return { content: [{ type: "text" as const, text: "WoL sent but GPU PC did not come online within 90 seconds." }], details: { success: false } };
  },
};

export const shutdownGpu: AgentTool = {
  name: "shutdown_gpu",
  label: "Shutdown GPU PC",
  description: "Gracefully shutdown the GPU PC",
  parameters: Type.Object({}),
  execute: async () => {
    try {
      const res = await fetch(`http://${GPU_HOST}:8765/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GPU_SHUTDOWN_TOKEN || ""}` },
      });
      const text = await res.text();
      return { content: [{ type: "text" as const, text: `Shutdown response: ${text}` }], details: { success: res.ok } };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Shutdown failed: ${e.message}` }], details: { success: false } };
    }
  },
};

export const gpuStatus: AgentTool = {
  name: "gpu_status",
  label: "GPU Status",
  description: "Check if GPU PC is online by querying Ollama",
  parameters: Type.Object({}),
  execute: async () => {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || []).map((m: any) => m.name).join(", ");
        return { content: [{ type: "text" as const, text: `GPU PC is online. Models: ${models || "none loaded"}` }], details: { online: true, models } };
      }
      return { content: [{ type: "text" as const, text: "GPU PC responded but Ollama returned an error." }], details: { online: false } };
    } catch {
      return { content: [{ type: "text" as const, text: "GPU PC is offline." }], details: { online: false } };
    }
  },
};
