import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { context, propagation } from "@opentelemetry/api";
import { log } from "../logger.js";
import { getAgentWeaveSession } from "../agentweave-context.js";

const NIX_A2A_URL = process.env.NIX_A2A_URL || "http://localhost:8771";
const A2A_SHARED_SECRET = process.env.A2A_SHARED_SECRET || "";

const authHeaders: Record<string, string> = A2A_SHARED_SECRET
  ? { Authorization: `Bearer ${A2A_SHARED_SECRET}` }
  : {};

export const delegateToNix: AgentTool = {
  name: "delegate_to_nix",
  label: "Delegate to Nix",
  description: "Send a task to Nix agent on the NAS via A2A protocol. Use this tool when: (1) asked to search memory or recall notes, (2) sending WhatsApp/Telegram messages, (3) scheduling cron jobs, (4) accessing NAS files, (5) explicitly told to use this tool or 'ask Nix'. Available skills: send_telegram, recall_search, schedule_cron, memory_query, general.",
  parameters: Type.Object({
    task: Type.String({ description: "Task description for Nix" }),
    skill_id: Type.Optional(Type.String({ description: "Nix skill to invoke: send_telegram, recall_search, schedule_cron, memory_query, general. Defaults to general." })),
  }),
  execute: async (_id, params: any, signal) => {
    const { task, skill_id } = params;
    const taskId = crypto.randomUUID();

    try {
      // Submit task async — Nix returns immediately with status "submitted"
      const res = await fetch(`${NIX_A2A_URL}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          ...(() => { const h: Record<string, string> = {}; propagation.inject(context.active(), h); return h; })(),
          // AgentWeave session attribution for trace propagation
          "X-AgentWeave-Parent-Session-Id": getAgentWeaveSession(),
          "X-AgentWeave-Delegated-Session-Id": `nix-a2a-${taskId}`,
          "X-AgentWeave-Agent-Id": process.env.AGENTWEAVE_AGENT_ID || "max-v1",
          "X-AgentWeave-Task-Label": `a2a:${skill_id || "general"}:${task.slice(0, 50)}`,
        },
        body: JSON.stringify({
          id: taskId,
          skill_id: skill_id || "general",
          message: {
            role: "user",
            parts: [{ type: "text", text: task }],
          },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          content: [{ type: "text" as const, text: `Nix rejected task: ${errText}` }],
          details: { success: false, error: errText },
        };
      }

      let data = await res.json();
      const pollTaskId = data.id || taskId;
      log("info", `Nix POST response: status=${data.status} id=${pollTaskId}`);

      // Poll until terminal state
      const TERMINAL_STATES = ["completed", "failed", "canceled", "rejected"];
      const POLL_INTERVAL = 3000;
      const MAX_POLL_TIME = 120000; // 2 minutes
      const pollStart = Date.now();

      while (!TERMINAL_STATES.includes(data.status) && Date.now() - pollStart < MAX_POLL_TIME) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));

        const pollRes = await fetch(`${NIX_A2A_URL}/tasks/${pollTaskId}`, {
          method: "GET",
          headers: { ...authHeaders },
          signal: AbortSignal.timeout(10000),
        });

        if (!pollRes.ok) {
          throw new Error(`Nix poll returned ${pollRes.status}`);
        }

        data = await pollRes.json();
        log("info", `Nix poll: status=${data.status} hasReply=${!!data.result?.reply} elapsed=${Math.round((Date.now() - pollStart) / 1000)}s`);
      }

      if (!TERMINAL_STATES.includes(data.status)) {
        return {
          content: [{ type: "text" as const, text: "Nix is still processing the task after 2 minutes. It may complete later." }],
          details: { success: false, taskId: pollTaskId, status: data.status },
        };
      }

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
