import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const NIX_A2A_URL = process.env.NIX_A2A_URL || "http://localhost:8771";
const A2A_SHARED_SECRET = process.env.A2A_SHARED_SECRET || "";

const authHeaders: Record<string, string> = A2A_SHARED_SECRET
  ? { Authorization: `Bearer ${A2A_SHARED_SECRET}` }
  : {};

export const delegateToNix: AgentTool = {
  name: "delegate_to_nix",
  label: "Delegate to Nix",
  description: "Send a task to Nix agent on NAS via A2A protocol. Use for: memory lookups, sending WhatsApp, scheduling cron jobs. Available skills: send_telegram, recall_search, schedule_cron, memory_query, general.",
  parameters: Type.Object({
    task: Type.String({ description: "Task description for Nix" }),
    skill_id: Type.Optional(Type.String({ description: "Nix skill to invoke: send_telegram, recall_search, schedule_cron, memory_query, general. Defaults to general." })),
  }),
  execute: async (_id, params: any, signal) => {
    const { task, skill_id } = params;
    const taskId = crypto.randomUUID();

    try {
      // Submit task (sync mode — Nix returns the reply directly)
      const res = await fetch(`${NIX_A2A_URL}/tasks?sync=true`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({
          id: taskId,
          skill_id: skill_id || "general",
          message: {
            role: "user",
            parts: [{ type: "text", text: task }],
          },
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          content: [{ type: "text" as const, text: `Nix rejected task: ${errText}` }],
          details: { success: false, error: errText },
        };
      }

      const data = await res.json();

      if (data.status === "failed") {
        throw new Error(data.error || "Nix task failed");
      }

      const replyText = data.result?.reply || "(Nix completed but returned no reply)";

      return {
        content: [{ type: "text" as const, text: replyText }],
        details: { success: true, taskId, result: data },
      };
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `Failed to reach Nix: ${e.message}` }],
        details: { success: false, error: e.message },
      };
    }
  },
};
