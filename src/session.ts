import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getState, setState } from "./task-journal.js";
import { log } from "./logger.js";
import { MAIN_SESSION_KEY } from "./session-context.js";

const LEGACY_SESSION_KEY = "session_messages";
const MAX_TOOL_RESULT_CHARS = 2000; // truncate tool results to prevent session bloat
const MAX_SESSION_MESSAGES = 20; // only save the most recent messages
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function sessionStorageKey(sessionKey: string = MAIN_SESSION_KEY): string {
  return `session_messages:${sessionKey}`;
}

function loadSessionJson(sessionKey: string): string | undefined {
  const scopedKey = sessionStorageKey(sessionKey);
  const scoped = getState(scopedKey);
  if (scoped !== undefined) return scoped;

  if (sessionKey === MAIN_SESSION_KEY) {
    const legacy = getState(LEGACY_SESSION_KEY);
    if (legacy !== undefined) {
      setState(scopedKey, legacy);
      log("info", `Migrated legacy ${LEGACY_SESSION_KEY} to ${scopedKey}`);
    }
    return legacy;
  }

  return undefined;
}

/**
 * Truncate large tool results, strip thinking blocks, and limit message count
 * before saving. Ensures the saved sequence starts at a user message boundary
 * so restored sessions produce valid API requests.
 */
function trimForStorage(messages: AgentMessage[]): AgentMessage[] {
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
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const filtered = m.content.filter((c: any) => c.type !== "thinking");
      if (filtered.length === 0) {
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
export function saveSession(agent: Agent, sessionKey: string = MAIN_SESSION_KEY): void {
  const existing = saveTimers.get(sessionKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    try {
      const { messages: repaired } = repairErroredAssistantTurns(agent.state.messages);
      const trimmed = trimForStorage(repaired);
      const json = JSON.stringify(trimmed);
      setState(sessionStorageKey(sessionKey), json);
      log("info", `Session ${sessionKey} saved (${trimmed.length} of ${agent.state.messages.length} messages)`);
    } catch (e: any) {
      log("error", `Failed to save session ${sessionKey}: ${e.message}`);
    } finally {
      saveTimers.delete(sessionKey);
    }
  }, 500);
  saveTimers.set(sessionKey, timer);
}

/**
 * Rewrite assistant messages whose stopReason is "error"/"aborted" but whose
 * content is actually non-empty.
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
export function restoreSession(agent: Agent, sessionKey: string = MAIN_SESSION_KEY): number {
  try {
    const json = loadSessionJson(sessionKey);
    if (!json) {
      agent.state.messages = [];
      return 0;
    }

    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      agent.state.messages = [];
      return 0;
    }

    const { messages, repaired } = repairErroredAssistantTurns(parsed);
    agent.state.messages = messages;
    if (repaired > 0) {
      log("info", `Session ${sessionKey} restored (${messages.length} messages, repaired ${repaired} errored assistant turns)`);
    } else {
      log("info", `Session ${sessionKey} restored (${messages.length} messages)`);
    }
    return messages.length;
  } catch (e: any) {
    log("error", `Failed to restore session ${sessionKey}: ${e.message}`);
    agent.state.messages = [];
    return 0;
  }
}

/**
 * Clear saved session from SQLite.
 */
export function clearSession(sessionKey: string = MAIN_SESSION_KEY): void {
  try {
    const existing = saveTimers.get(sessionKey);
    if (existing) clearTimeout(existing);
    saveTimers.delete(sessionKey);
    setState(sessionStorageKey(sessionKey), "[]");
    log("info", `Session ${sessionKey} cleared`);
  } catch (e: any) {
    log("error", `Failed to clear session ${sessionKey}: ${e.message}`);
  }
}
