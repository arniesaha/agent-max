import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getState, setState } from "./task-journal.js";
import { log } from "./logger.js";

const SESSION_KEY = "session_messages";
const MAX_TOOL_RESULT_CHARS = 2000; // truncate tool results to prevent session bloat
const MAX_SESSION_MESSAGES = 20; // only save the most recent messages
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Truncate large tool results and limit message count before saving,
 * to prevent session restore from immediately exceeding the compaction threshold.
 */
function trimForStorage(messages: AgentMessage[]): AgentMessage[] {
  // Only keep the most recent messages
  const recent = messages.slice(-MAX_SESSION_MESSAGES);
  return recent.map((msg) => {
    const m = msg as any;
    if (m.role === "toolResult" && Array.isArray(m.content)) {
      const trimmedContent = m.content.map((c: any) => {
        if (c.type === "text" && c.text && c.text.length > MAX_TOOL_RESULT_CHARS) {
          return { ...c, text: c.text.slice(0, MAX_TOOL_RESULT_CHARS) + "\n...[truncated for session storage]" };
        }
        if (c.type === "image") {
          // Drop image data from saved sessions (too large)
          return { type: "text", text: "[image omitted from session storage]" };
        }
        return c;
      });
      return { ...m, content: trimmedContent };
    }
    // Also truncate large assistant thinking blocks
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const trimmedContent = m.content.map((c: any) => {
        if (c.type === "thinking" && c.thinking && c.thinking.length > MAX_TOOL_RESULT_CHARS) {
          return { ...c, thinking: c.thinking.slice(0, MAX_TOOL_RESULT_CHARS) + "\n...[truncated]" };
        }
        return c;
      });
      return { ...m, content: trimmedContent };
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
      const trimmed = trimForStorage(agent.state.messages);
      const json = JSON.stringify(trimmed);
      setState(SESSION_KEY, json);
      log("info", `Session saved (${trimmed.length} of ${agent.state.messages.length} messages)`);
    } catch (e: any) {
      log("error", `Failed to save session: ${e.message}`);
    }
  }, 500);
}

/**
 * Restore agent messages from SQLite.
 * Returns the number of messages restored.
 */
export function restoreSession(agent: Agent): number {
  try {
    const json = getState(SESSION_KEY);
    if (!json) return 0;

    const messages = JSON.parse(json);
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    agent.state.messages = messages;
    log("info", `Session restored (${messages.length} messages)`);
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
