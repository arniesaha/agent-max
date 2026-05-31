import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getState, setState } from "./task-journal.js";
import { log } from "./logger.js";
import { MAIN_SESSION_KEY } from "./session-context.js";

const LEGACY_SESSION_KEY = "session_messages";
const SESSION_MESSAGES_PREFIX = "session_messages:";
const SESSION_SUMMARY_PREFIX = "session_summary:";
const SESSION_BRIEF_PREFIX = "session_active_brief:";
const MAX_TOOL_RESULT_CHARS = 2000; // truncate tool results to prevent session bloat
const MAX_SESSION_MESSAGES = 20; // only save the most recent messages
const MAX_SESSION_SUMMARY_CHARS = 8192;
const MAX_BRIEF_MD_CHARS = 2048;
const MAX_BRIEF_FIELD_CHARS = 512;
const MAX_BRIEF_LIST_ITEMS = 8;
const MAX_BRIEF_LIST_ITEM_CHARS = 160;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const DEFAULT_SESSION_KEY = MAIN_SESSION_KEY;

export interface SessionActiveBrief {
  brief_md: string;
  last_user_req?: string;
  current_objective?: string;
  suggested_next?: string[];
  files_touched?: string[];
  open_blockers?: string;
  updated_at?: number;
}

function scopedKey(prefix: string, sessionKey = DEFAULT_SESSION_KEY): string {
  return `${prefix}${sessionKey || DEFAULT_SESSION_KEY}`;
}

export function sessionStorageKey(sessionKey: string = DEFAULT_SESSION_KEY): string {
  return scopedKey(SESSION_MESSAGES_PREFIX, sessionKey);
}

function loadSessionJson(sessionKey: string): string | undefined {
  const scoped = getState(sessionStorageKey(sessionKey));
  if (scoped !== undefined) return scoped;

  if (sessionKey === MAIN_SESSION_KEY) {
    const legacy = getState(LEGACY_SESSION_KEY);
    if (legacy !== undefined) {
      setState(sessionStorageKey(sessionKey), legacy);
      log("info", `Migrated legacy ${LEGACY_SESSION_KEY} to ${sessionStorageKey(sessionKey)}`);
    }
    return legacy;
  }

  return undefined;
}

function capText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars - 15).trimEnd()}\n...[truncated]` : text;
}

function capStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => capText(item, MAX_BRIEF_LIST_ITEM_CHARS))
    .filter((item): item is string => Boolean(item))
    .slice(0, MAX_BRIEF_LIST_ITEMS);
  return items.length > 0 ? items : undefined;
}

export function normalizeActiveBrief(brief: Partial<SessionActiveBrief>): SessionActiveBrief {
  const normalized: SessionActiveBrief = {
    brief_md: capText(brief.brief_md ?? "", MAX_BRIEF_MD_CHARS) ?? "",
    updated_at: typeof brief.updated_at === "number" ? brief.updated_at : Date.now(),
  };

  const lastUserReq = capText(brief.last_user_req, MAX_BRIEF_FIELD_CHARS);
  if (lastUserReq) normalized.last_user_req = lastUserReq;
  const objective = capText(brief.current_objective, MAX_BRIEF_FIELD_CHARS);
  if (objective) normalized.current_objective = objective;
  const blockers = capText(brief.open_blockers, MAX_BRIEF_FIELD_CHARS);
  if (blockers) normalized.open_blockers = blockers;
  const next = capStringList(brief.suggested_next);
  if (next) normalized.suggested_next = next.slice(0, 3);
  const files = capStringList(brief.files_touched);
  if (files) normalized.files_touched = files;

  return normalized;
}

export function getSessionSummary(sessionKey = DEFAULT_SESSION_KEY): string | undefined {
  return getState(scopedKey(SESSION_SUMMARY_PREFIX, sessionKey));
}

export function setSessionSummary(sessionKey: string | undefined, summary: string): void {
  const key = sessionKey || DEFAULT_SESSION_KEY;
  const capped = capText(summary, MAX_SESSION_SUMMARY_CHARS) ?? "";
  setState(scopedKey(SESSION_SUMMARY_PREFIX, key), capped);
  log("info", `Session summary saved (session=${key}, chars=${capped.length})`);
}

export function getActiveBrief(sessionKey = DEFAULT_SESSION_KEY): SessionActiveBrief | undefined {
  const json = getState(scopedKey(SESSION_BRIEF_PREFIX, sessionKey));
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as Partial<SessionActiveBrief>;
    const brief = normalizeActiveBrief(parsed);
    return brief.brief_md || brief.current_objective || brief.open_blockers ? brief : undefined;
  } catch (e: any) {
    log("warn", `Failed to parse active brief (session=${sessionKey}): ${e.message}`);
    return undefined;
  }
}

export function setActiveBrief(sessionKey: string | undefined, brief: Partial<SessionActiveBrief>): SessionActiveBrief {
  const key = sessionKey || DEFAULT_SESSION_KEY;
  const normalized = normalizeActiveBrief(brief);
  setState(scopedKey(SESSION_BRIEF_PREFIX, key), JSON.stringify(normalized));
  log("info", `Active brief saved (session=${key}, chars=${normalized.brief_md.length})`);
  return normalized;
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
export function saveSession(agent: Agent, sessionKey: string = DEFAULT_SESSION_KEY): void {
  const storageKey = sessionStorageKey(sessionKey);
  const existing = saveTimers.get(storageKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    try {
      const { messages: repaired } = repairErroredAssistantTurns(agent.state.messages);
      const trimmed = trimForStorage(repaired);
      const json = JSON.stringify(trimmed);
      setState(storageKey, json);
      log("info", `Session ${sessionKey} saved (${trimmed.length} of ${agent.state.messages.length} messages)`);
    } catch (e: any) {
      log("error", `Failed to save session ${sessionKey}: ${e.message}`);
    } finally {
      saveTimers.delete(storageKey);
    }
  }, 500);
  saveTimers.set(storageKey, timer);
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
export function restoreSession(agent: Agent, sessionKey: string = DEFAULT_SESSION_KEY): number {
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
export function clearSession(sessionKey: string = DEFAULT_SESSION_KEY): void {
  try {
    const storageKey = sessionStorageKey(sessionKey);
    const existing = saveTimers.get(storageKey);
    if (existing) clearTimeout(existing);
    saveTimers.delete(storageKey);
    setState(storageKey, "[]");
    log("info", `Session ${sessionKey} cleared`);
  } catch (e: any) {
    log("error", `Failed to clear session ${sessionKey}: ${e.message}`);
  }
}
