import { parentPort, workerData } from "worker_threads";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createAgent } from "./agent.js";
import { setAgentWeaveSession, resetAgentWeaveSession } from "./agentweave-context.js";
import { log } from "./logger.js";
import { saveSession } from "./session.js";

const AGENTWEAVE_MAX_PROXY = process.env.AGENTWEAVE_PROXY_URL || "http://192.168.1.70:30400";

export interface WorkerProgressEvent {
  type: "progress" | "complete" | "error";
  taskId: string;
  message?: string;
  result?: string;
  error?: string;
}

interface WorkerTaskData {
  taskId: string;
  text: string;
  parentSessionId?: string;
  delegatedSessionId?: string;
  callerAgentId?: string;
  taskLabel?: string;
}

async function postProgress(event: WorkerProgressEvent): Promise<void> {
  parentPort?.postMessage(event);
}

async function main() {
  const { taskId, text, parentSessionId, delegatedSessionId, callerAgentId, taskLabel } = workerData as WorkerTaskData;
  const AGENTWEAVE_PROXY_TOKEN = process.env.AGENTWEAVE_PROXY_TOKEN;

  try {
    await postProgress({ type: "progress", taskId, message: "Worker started" });

    if (parentSessionId) {
      const sessionId = delegatedSessionId || `max-a2a-${taskId}`;
      try {
        await fetch(`${AGENTWEAVE_MAX_PROXY}/session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(AGENTWEAVE_PROXY_TOKEN ? { Authorization: `Bearer ${AGENTWEAVE_PROXY_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            session_id: sessionId,
            parent_session_id: parentSessionId,
            task_label: taskLabel || `a2a from ${callerAgentId || "nix"}`,
            agent_type: "delegated",
          }),
        });
        setAgentWeaveSession(sessionId);
      } catch (e: any) {
        log("warn", `Worker AgentWeave session set failed: ${e.message}`);
      }
    }

    const agent = await createAgent();
    let responseText = "";

    const unsub = agent.subscribe((event: AgentEvent) => {
      if (event.type === "tool_execution_start") {
        void postProgress({ type: "progress", taskId, message: `Tool: ${event.toolName}` });
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        responseText += event.assistantMessageEvent.delta;
      }
    });

    await agent.prompt(text);
    unsub();

    if (!responseText) {
      const lastMsg = agent.state.messages[agent.state.messages.length - 1];
      if (lastMsg && "content" in lastMsg && lastMsg.role === "assistant") {
        responseText = lastMsg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
      }
    }

    saveSession(agent);
    await postProgress({ type: "complete", taskId, message: "Worker completed", result: responseText });
  } catch (e: any) {
    await postProgress({ type: "error", taskId, error: e?.message || String(e) });
  } finally {
    if (parentSessionId) {
      resetAgentWeaveSession();
      const AGENTWEAVE_PROXY_TOKEN = process.env.AGENTWEAVE_PROXY_TOKEN;
      fetch(`${AGENTWEAVE_MAX_PROXY}/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(AGENTWEAVE_PROXY_TOKEN ? { Authorization: `Bearer ${AGENTWEAVE_PROXY_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          session_id: "max-main",
          parent_session_id: "",
          task_label: "",
          agent_type: "main",
        }),
      }).catch(() => {});
    }
  }
}

void main();
