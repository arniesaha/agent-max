import { parentPort, workerData } from "worker_threads";
import { context, propagation } from "@opentelemetry/api";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createAgent } from "./agent.js";
import { makeA2ASessionContext, withSessionContext, type SessionContext } from "./agentweave-context.js";
import { log } from "./logger.js";
import { saveSession } from "./session.js";
import { emitSessionArtifact, inferProjectsFromText } from "./session-emit.js";

const AGENTWEAVE_MAX_PROXY = process.env.AGENTWEAVE_PROXY_URL || "http://arnabsnas.local:30400";

export interface WorkerProgressEvent {
  type: "progress" | "complete" | "error";
  taskId: string;
  message?: string;
  result?: string;
  error?: string;
  /** Cumulative cost in USD at terminal events (complete/error). */
  costUsd?: number;
  /** True when termination was caused by exceeding the per-task budget cap. */
  budgetExceeded?: boolean;
}

interface WorkerTaskData {
  taskId: string;
  text: string;
  parentSessionId?: string;
  parentSessionKey?: string;
  delegatedSessionId?: string;
  delegatedSessionKey?: string;
  callerAgentId?: string;
  taskLabel?: string;
  sessionContext?: SessionContext;
  /** Serialized W3C trace headers (e.g. traceparent) from the calling agent. */
  traceHeaders?: Record<string, string>;
  /** Per-task USD spend cap. When exceeded, the agent is aborted. */
  maxBudgetUsd?: number | null;
}

/**
 * Extract USD cost from a turn_end event. Returns 0 for non-assistant turns
 * or messages without usage data. Pure helper, exported for tests.
 */
export function costFromTurnEnd(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const m = message as { role?: string; usage?: { cost?: { total?: number } } };
  if (m.role !== "assistant") return 0;
  return m.usage?.cost?.total ?? 0;
}

async function postProgress(event: WorkerProgressEvent): Promise<void> {
  parentPort?.postMessage(event);
}

async function main() {
  const { taskId, text, parentSessionId, parentSessionKey, delegatedSessionId, delegatedSessionKey, callerAgentId, taskLabel, traceHeaders, maxBudgetUsd } = workerData as WorkerTaskData;

  // Re-extract trace context from serialized headers so this worker's spans
  // are linked as children of the calling agent's trace.
  const incomingContext = traceHeaders
    ? propagation.extract(context.active(), traceHeaders)
    : context.active();
  const AGENTWEAVE_PROXY_TOKEN = process.env.AGENTWEAVE_PROXY_TOKEN;

  // Hoisted so the catch block can include accumulated cost in its error event.
  let cumulativeCostUsd = 0;
  await context.with(incomingContext, async () => {
  try {
    await postProgress({ type: "progress", taskId, message: "Worker started" });

    const sessionContext = (workerData as WorkerTaskData).sessionContext ?? makeA2ASessionContext({
      taskId,
      sync: false,
      parentSessionId,
      parentSessionKey,
      delegatedSessionId,
      delegatedSessionKey,
      callerAgentId,
      taskLabel,
    });

    await withSessionContext(sessionContext, async () => {
    if (sessionContext.parentSessionId) {
      try {
        await fetch(`${AGENTWEAVE_MAX_PROXY}/session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(AGENTWEAVE_PROXY_TOKEN ? { Authorization: `Bearer ${AGENTWEAVE_PROXY_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            session_id: sessionContext.sessionId,
            session_key: sessionContext.sessionKey,
            parent_session_id: sessionContext.parentSessionId,
            parent_session_key: sessionContext.parentSessionKey,
            task_label: sessionContext.taskLabel || taskLabel || `a2a from ${callerAgentId || "nix"}`,
            agent_type: "delegated",
          }),
        });
      } catch (e: any) {
        log("warn", `Worker AgentWeave session set failed: ${e.message}`);
      }
    }

    const agent = await createAgent(sessionContext);
    let responseText = "";
    let budgetExceeded = false;

    const unsub = agent.subscribe((event: AgentEvent) => {
      if (event.type === "tool_execution_start") {
        void postProgress({ type: "progress", taskId, message: `Tool: ${event.toolName}` });
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        responseText += event.assistantMessageEvent.delta;
      }
      if (event.type === "turn_end") {
        cumulativeCostUsd += costFromTurnEnd(event.message);
        if (
          typeof maxBudgetUsd === "number" &&
          maxBudgetUsd > 0 &&
          !budgetExceeded &&
          cumulativeCostUsd > maxBudgetUsd
        ) {
          budgetExceeded = true;
          log(
            "warn",
            `Task ${taskId} exceeded budget cap: $${cumulativeCostUsd.toFixed(4)} > $${maxBudgetUsd.toFixed(2)} — aborting`
          );
          agent.abort();
        }
      }
    });

    await agent.prompt(text);
    unsub();

    if (budgetExceeded) {
      saveSession(agent, sessionContext);
      emitSessionArtifact({
        topic: taskLabel || text.slice(0, 80),
        projects: inferProjectsFromText(text),
        type: "maintenance",
      });
      await postProgress({
        type: "error",
        taskId,
        error: `Budget exceeded: $${cumulativeCostUsd.toFixed(4)} of $${(maxBudgetUsd as number).toFixed(2)} cap`,
        costUsd: cumulativeCostUsd,
        budgetExceeded: true,
      });
      return;
    }

    if (!responseText) {
      const lastMsg = agent.state.messages[agent.state.messages.length - 1];
      if (lastMsg && "content" in lastMsg && lastMsg.role === "assistant") {
        responseText = lastMsg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
      }
    }

    // Check for LLM errors (rate limits, timeouts, 500s) surfaced as
    // AssistantMessage with stopReason: "error" and errorMessage field.
    if (!responseText) {
      const lastMsg: any = agent.state.messages[agent.state.messages.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg.stopReason === "error" && lastMsg.errorMessage) {
        saveSession(agent, sessionContext);
        emitSessionArtifact({
          topic: taskLabel || text.slice(0, 80),
          projects: inferProjectsFromText(text),
          type: "maintenance",
        });
        await postProgress({
          type: "error",
          taskId,
          error: `LLM error: ${lastMsg.errorMessage}`,
          costUsd: cumulativeCostUsd,
        });
        return;
      }
    }

    saveSession(agent, sessionContext);
    emitSessionArtifact({
      topic: taskLabel || text.slice(0, 80),
      projects: inferProjectsFromText(text),
      type: "coding",
    });
    await postProgress({
      type: "complete",
      taskId,
      message: "Worker completed",
      result: responseText,
      costUsd: cumulativeCostUsd,
    });
    });
  } catch (e: any) {
    emitSessionArtifact({
      topic: taskLabel || text.slice(0, 80),
      projects: inferProjectsFromText(text),
      type: "maintenance",
    });
    await postProgress({
      type: "error",
      taskId,
      error: e?.message || String(e),
      costUsd: cumulativeCostUsd,
    });
  } finally {
    // Session attribution is scoped with AsyncLocalStorage; no process-global reset needed.
  }
  }); // end context.with
}

// Only auto-run when actually loaded as a worker thread (parentPort exists
// and workerData is set). Lets tests import pure helpers from this file
// without spinning up the agent.
if (parentPort && workerData) {
  void main();
}
