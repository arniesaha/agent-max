import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getState, setState } from "./task-journal.js";
import { log } from "./logger.js";

const SESSION_KEY = "session_messages";
const MAX_TOOL_RESULT_CHARS = 2000; // truncate tool results to prevent session bloat
const MAX_SESSION_MESSAGES = 20; // only save the most recent messages
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Truncate large tool results, strip thinking blocks, and limit message count
 * before saving. Ensures the saved sequence starts at a user message boundary
 * so restored sessions produce valid API requests.
 */
function trimForStorage(messages: AgentMessage[]): AgentMessage[] {
  // Find a starting point within the last MAX_SESSION_MESSAGES that begins with a user message
  let startIdx = Math.max(0, messages.length - MAX_SESSION_MESSAGES);
  while (startIdx < messages.length && (messages[startIdx] as any).role !== "user") {
    startIdx++;
  }
  if (startIdx >= messages.length) return [];

  const recent = messages.slice(startIdx);
  return recent.map((msg) => {
    const m = msg as any;
    if (m.role === "toolResult" && Array.isArray(m.content)) {
      const trimmedContent = m.content.map((c: any) => {
        if (c.type === "text" && c.text && c.text.length > MAX_TOOL_RESULT_CHARS) {
          return { ...c, text: c.text.slice(0, MAX_TOOL_RESULT_CHARS) + "\n...[truncated]" };
        }
        if (c.type === "image") {
          return { type: "text", text: "[image omitted from session storage]" };
        }
        return c;
      });
      return { ...m, content: trimmedContent };
    }
    // Strip thinking blocks entirely — they contain signatures that break
    // when truncated, and the model doesn't need them for continuity.
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const filtered = m.content.filter((c: any) => c.type !== "thinking");
      if (filtered.length === 0) {
        // Thinking-only response — replace with a minimal text block
        return { ...m, content: [{ type: "text", text: "(thinking)" }] };
      }
      return { ...m, content: filtered };
    }
    return msg;
  });
}

/**
 * Save agent messages to SQLite (debounced 500ms).
 */
export function saveSession(agent: Agent): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const { messages: repaired } = repairErroredAssistantTurns(agent.state.messages);
      const trimmed = trimForStorage(repaired);
      const json = JSON.stringify(trimmed);
      setState(SESSION_KEY, json);
      log("info", `Session saved (${trimmed.length} of ${agent.state.messages.length} messages)`);
    } catch (e: any) {
      log("error", `Failed to save session: ${e.message}`);
    }
  }, 500);
}

/**
 * Rewrite assistant messages whose stopReason is "error"/"aborted" but whose
 * content is actually non-empty. This undoes damage from a prior mux regression
 * that passed Anthropic stop_reason values (e.g. "end_turn") through as
 * OpenAI finish_reason, causing pi-ai's mapStopReason to throw after the text
 * had already streamed. The assistant message was persisted with valid content
 * but stopReason="error", which transform-messages.js then dropped on every
 * subsequent turn — producing the +1/turn context bleed.
 */
function repairErroredAssistantTurns(messages: AgentMessage[]): { messages: AgentMessage[]; repaired: number } {
  let repaired = 0;
  const out = messages.map((msg) => {
    const m = msg as any;
    if (m.role !== "assistant") return msg;
    if (m.stopReason !== "error" && m.stopReason !== "aborted") return msg;
    const hasRealText = Array.isArray(m.content) &&
      m.content.some((c: any) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0);
    if (!hasRealText) return msg;
    repaired++;
    const { errorMessage, ...rest } = m;
    return { ...rest, stopReason: "stop" };
  });
  return { messages: out, repaired };
}

/**
 * Restore agent messages from SQLite.
 * Returns the number of messages restored.
 */
export function restoreSession(agent: Agent): number {
  try {
    const json = getState(SESSION_KEY);
    if (!json) return 0;

    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return 0;

    const { messages, repaired } = repairErroredAssistantTurns(parsed);
    agent.state.messages = messages;
    if (repaired > 0) {
      log("info", `Session restored (${messages.length} messages, repaired ${repaired} errored assistant turns)`);
    } else {
      log("info", `Session restored (${messages.length} messages)`);
    }
    return messages.length;
  } catch (e: any) {
    log("error", `Failed to restore session: ${e.message}`);
    return 0;
  }
}

/**
 * Clear saved session from SQLite.
 */
export function clearSession(): void {
  try {
    setState(SESSION_KEY, "[]");
    log("info", "Session cleared");
  } catch (e: any) {
    log("error", `Failed to clear session: ${e.message}`);
  }
}
