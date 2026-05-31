import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getState, setState } from "./task-journal.js";
import { log } from "./logger.js";
import { getSessionContext, MAIN_SESSION_CONTEXT, type SessionContext } from "./agentweave-context.js";

const LEGACY_SESSION_KEY = "session_messages";
const SESSION_KEY_PREFIX = "session_messages:";
const MAX_TOOL_RESULT_CHARS = 2000; // truncate tool results to prevent session bloat
const MAX_SESSION_MESSAGES = 20; // only save the most recent messages
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function contextOrActive(ctx?: SessionContext): SessionContext {
  return ctx ?? getSessionContext();
}

export function storageKeyForSession(ctxOrKey?: SessionContext | string): string {
  const sessionKey = typeof ctxOrKey === "string"
    ? ctxOrKey
    : contextOrActive(ctxOrKey).sessionKey;
  return `${SESSION_KEY_PREFIX}${sessionKey}`;
}

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
export function saveSession(agent: Agent, ctx?: SessionContext): void {
  const sessionContext = contextOrActive(ctx);
  const stateKey = storageKeyForSession(sessionContext);
  const messages = [...agent.state.messages];
  const existingTimer = saveTimers.get(stateKey);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    try {
      const { messages: repaired } = repairErroredAssistantTurns(messages);
      const trimmed = trimForStorage(repaired);
      const json = JSON.stringify(trimmed);
      setState(stateKey, json);
      log("info", `Session saved for ${sessionContext.sessionKey} (${trimmed.length} of ${messages.length} messages)`);
    } catch (e: any) {
      log("error", `Failed to save session ${sessionContext.sessionKey}: ${e.message}`);
    } finally {
      saveTimers.delete(stateKey);
    }
  }, 500);
  saveTimers.set(stateKey, timer);
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
 * Load session messages from SQLite without mutating an Agent instance.
 */
export function loadSessionMessages(ctx?: SessionContext): AgentMessage[] {
  const sessionContext = contextOrActive(ctx);
  const stateKey = storageKeyForSession(sessionContext);
  try {
    let json = getState(stateKey);
    if (!json && sessionContext.sessionKey === MAIN_SESSION_CONTEXT.sessionKey) {
      json = getState(LEGACY_SESSION_KEY);
    }
    if (!json) {
      return [];
    }

    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [];
    }

    const { messages, repaired } = repairErroredAssistantTurns(parsed);
    if (repaired > 0) {
      log("info", `Session loaded for ${sessionContext.sessionKey} (${messages.length} messages, repaired ${repaired} errored assistant turns)`);
    } else {
      log("info", `Session loaded for ${sessionContext.sessionKey} (${messages.length} messages)`);
    }
    return messages;
  } catch (e: any) {
    log("error", `Failed to load session ${sessionContext.sessionKey}: ${e.message}`);
    return [];
  }
}

/**
 * Restore agent messages from SQLite.
 * Returns the number of messages restored.
 */
export function restoreSession(agent: Agent, ctx?: SessionContext): number {
  const messages = loadSessionMessages(ctx);
  agent.state.messages = messages;
  return messages.length;
}

/**
 * Clear saved session from SQLite.
 */
export function clearSession(ctx?: SessionContext): void {
  const sessionContext = contextOrActive(ctx);
  try {
    setState(storageKeyForSession(sessionContext), "[]");
    if (sessionContext.sessionKey === MAIN_SESSION_CONTEXT.sessionKey) {
      setState(LEGACY_SESSION_KEY, "[]");
    }
    log("info", `Session cleared for ${sessionContext.sessionKey}`);
  } catch (e: any) {
    log("error", `Failed to clear session ${sessionContext.sessionKey}: ${e.message}`);
  }
}
