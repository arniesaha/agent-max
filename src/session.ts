import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { getState, setState } from "./task-journal.js";
import { log } from "./logger.js";
import { getAgentWeaveSession } from "./agentweave-context.js";
import { traceContextEvent } from "./tracing.js";

const SESSION_KEY = "session_messages";
const MAX_TOOL_RESULT_CHARS = 2000; // truncate tool results to prevent session bloat
const MAX_SESSION_MESSAGES = 20; // only save the most recent messages
const ACTIVE_BRIEF_MAX_CHARS = 2048;
const ACTIVE_BRIEF_LIST_MAX = 8;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface SessionOptions {
  sessionKey?: string;
}

export interface SessionBrief {
  brief_md: string;
  last_user_req: string;
  current_objective: string;
  suggested_next: string[];
  files_touched: string[];
  open_blockers: string;
  updated_at: number;
}

function normalizeSessionKey(sessionKey?: string): string {
  return sessionKey || getAgentWeaveSession() || "max-main";
}

function scopedStateKey(prefix: string, sessionKey?: string): string {
  return `${prefix}:${normalizeSessionKey(sessionKey)}`;
}

function truncateText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n...[truncated]`;
}

function uniqueCapped(values: string[], max = ACTIVE_BRIEF_LIST_MAX): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function extractText(msg: AgentMessage): string {
  const m = msg as any;
  if (m.role === "user") {
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }
  }
  if ((m.role === "assistant" || m.role === "toolResult") && Array.isArray(m.content)) {
    return m.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

function extractFilesTouched(messages: AgentMessage[]): string[] {
  const text = messages.map(extractText).join("\n");
  const matches = text.match(/(?:\/[\w.-]+)+(?:\.[\w.-]+)?|(?:src|tests|docs|scripts|dist)\/[^\s'"`)]+/g) ?? [];
  return uniqueCapped(matches.map((m) => m.replace(/[),.;:]+$/, "")));
}

export function capSessionBrief(brief: Omit<SessionBrief, "updated_at"> & Partial<Pick<SessionBrief, "updated_at">>): SessionBrief {
  return {
    brief_md: truncateText(brief.brief_md || "", ACTIVE_BRIEF_MAX_CHARS),
    last_user_req: truncateText(brief.last_user_req || "", 500),
    current_objective: truncateText(brief.current_objective || "", 300),
    suggested_next: uniqueCapped((brief.suggested_next || []).map((v) => truncateText(v, 180)), 3),
    files_touched: uniqueCapped(brief.files_touched || []),
    open_blockers: truncateText(brief.open_blockers || "", 300),
    updated_at: brief.updated_at || Date.now(),
  };
}

export function getSessionBrief(sessionKey?: string): SessionBrief | null {
  try {
    const json = getState(scopedStateKey("session_brief", sessionKey));
    if (!json) return null;
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    return capSessionBrief({
      brief_md: String(parsed.brief_md || ""),
      last_user_req: String(parsed.last_user_req || ""),
      current_objective: String(parsed.current_objective || ""),
      suggested_next: Array.isArray(parsed.suggested_next) ? parsed.suggested_next.map(String) : [],
      files_touched: Array.isArray(parsed.files_touched) ? parsed.files_touched.map(String) : [],
      open_blockers: String(parsed.open_blockers || ""),
      updated_at: typeof parsed.updated_at === "number" ? parsed.updated_at : Date.now(),
    });
  } catch (e: any) {
    log("warn", `Failed to read session brief: ${e.message}`);
    return null;
  }
}

export function setSessionBrief(brief: Omit<SessionBrief, "updated_at"> & Partial<Pick<SessionBrief, "updated_at">>, sessionKey?: string): SessionBrief {
  const key = normalizeSessionKey(sessionKey);
  const capped = capSessionBrief({ ...brief, updated_at: Date.now() });
  setState(scopedStateKey("session_brief", key), JSON.stringify(capped));
  traceContextEvent("context.brief_update", {
    "session.id": key,
    "prov.session.id": key,
    "context.brief_chars": capped.brief_md.length,
    "context.brief_files": capped.files_touched.length,
  }, () => undefined);
  log("info", `Session brief updated for ${key} (${capped.brief_md.length} chars)`);
  return capped;
}

export function buildSessionBrief(messages: AgentMessage[]): SessionBrief | null {
  const latestUser = [...messages].reverse().find((msg) => (msg as any).role === "user");
  if (!latestUser) return null;
  const latestAssistant = [...messages].reverse().find((msg) => (msg as any).role === "assistant");
  const lastUserReq = truncateText(extractText(latestUser), 500);
  const assistantText = latestAssistant ? truncateText(extractText(latestAssistant), 900) : "";
  const toolNames = uniqueCapped(messages
    .filter((msg) => (msg as any).role === "toolResult" && (msg as any).toolName)
    .map((msg) => String((msg as any).toolName)));
  const filesTouched = extractFilesTouched(messages);
  const briefLines = [
    lastUserReq ? `Latest request: ${lastUserReq}` : "",
    assistantText ? `Latest response/outcome: ${assistantText}` : "",
    toolNames.length > 0 ? `Recent tools: ${toolNames.join(", ")}` : "",
    filesTouched.length > 0 ? `Files touched: ${filesTouched.join(", ")}` : "",
  ].filter(Boolean);
  if (briefLines.length === 0) return null;
  return capSessionBrief({
    brief_md: briefLines.join("\n"),
    last_user_req: lastUserReq,
    current_objective: lastUserReq,
    suggested_next: [],
    files_touched: filesTouched,
    open_blockers: "",
  });
}

export function updateSessionBriefFromMessages(messages: AgentMessage[], sessionKey?: string): SessionBrief | null {
  const key = normalizeSessionKey(sessionKey);
  try {
    const brief = buildSessionBrief(messages);
    if (!brief) return null;
    return setSessionBrief(brief, key);
  } catch (e: any) {
    log("warn", `Session brief update failed for ${key}: ${e.message}`);
    return null;
  }
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
export function saveSession(agent: Agent, options: SessionOptions = {}): void {
  const sessionKey = normalizeSessionKey(options.sessionKey);
  const existingTimer = saveTimers.get(sessionKey);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    saveTimers.delete(sessionKey);
    try {
      const { messages: repaired } = repairErroredAssistantTurns(agent.state.messages);
      const trimmed = trimForStorage(repaired);
      const json = JSON.stringify(trimmed);
      setState(scopedStateKey(SESSION_KEY, sessionKey), json);
      setState(SESSION_KEY, json);
      updateSessionBriefFromMessages(trimmed, sessionKey);
      log("info", `Session saved for ${sessionKey} (${trimmed.length} of ${agent.state.messages.length} messages)`);
    } catch (e: any) {
      log("error", `Failed to save session: ${e.message}`);
    }
  }, 500);
  saveTimers.set(sessionKey, timer);
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
export function restoreSession(agent: Agent, options: SessionOptions = {}): number {
  try {
    const sessionKey = normalizeSessionKey(options.sessionKey);
    const json = getState(scopedStateKey(SESSION_KEY, sessionKey)) ?? getState(SESSION_KEY);
    if (!json) return 0;

    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return 0;

    const { messages, repaired } = repairErroredAssistantTurns(parsed);
    agent.state.messages = messages;
    if (repaired > 0) {
      log("info", `Session restored for ${sessionKey} (${messages.length} messages, repaired ${repaired} errored assistant turns)`);
    } else {
      log("info", `Session restored for ${sessionKey} (${messages.length} messages)`);
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
export function clearSession(options: SessionOptions = {}): void {
  try {
    const sessionKey = normalizeSessionKey(options.sessionKey);
    setState(scopedStateKey(SESSION_KEY, sessionKey), "[]");
    setState(scopedStateKey("session_brief", sessionKey), JSON.stringify(capSessionBrief({
      brief_md: "",
      last_user_req: "",
      current_objective: "",
      suggested_next: [],
      files_touched: [],
      open_blockers: "",
    })));
    if (sessionKey === "max-main") setState(SESSION_KEY, "[]");
    log("info", `Session cleared for ${sessionKey}`);
  } catch (e: any) {
    log("error", `Failed to clear session: ${e.message}`);
  }
}
