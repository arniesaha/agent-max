import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { getModel, getEnvApiKey, streamSimple } from "@mariozechner/pi-ai";
import { log } from "./logger.js";
import { getAgentWeaveSession } from "./agentweave-context.js";
import { getSessionBrief } from "./session.js";
import { traceContextEvent } from "./tracing.js";

/**
 * Context-sizing knobs.
 *
 * Defaults target a Claude subscription path, where every input token counts
 * against the 5-hour rate limit — compact at ~150K before a long session can
 * exhaust quota.
 *
 * Override via env for providers with cheaper long context (e.g. Gemini direct):
 *   MAX_CONTEXT_WINDOW=1000000 MAX_COMPACT_THRESHOLD=0.8 MAX_KEEP_RECENT=6
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const CONTEXT_WINDOW = envNumber("MAX_CONTEXT_WINDOW", 200_000);
const COMPACT_THRESHOLD = envNumber("MAX_COMPACT_THRESHOLD", 0.75);
const TOKEN_LIMIT = Math.floor(CONTEXT_WINDOW * COMPACT_THRESHOLD);
const KEEP_RECENT = Math.floor(envNumber("MAX_KEEP_RECENT", 6));

let loggedConfig = false;
function logConfigOnce(): void {
  if (loggedConfig) return;
  loggedConfig = true;
  log(
    "info",
    `Context sizing: window=${CONTEXT_WINDOW} threshold=${TOKEN_LIMIT} (${Math.round(COMPACT_THRESHOLD * 100)}%) keepRecent=${KEEP_RECENT}`
  );
}

// How many user turns at the tail to keep tool-result bodies intact.
// Older toolResults beyond this window are replaced with a 1-line stub.
// This is the biggest in-session lever: a single gh-diff or browser-scrape
// otherwise re-bills itself on every subsequent agent iteration.
const FRESH_TURNS = Math.floor(Number(process.env.MAX_FRESH_TURNS || 4));
const STALE_STUB_CHARS = 200; // keep a tiny prefix for continuity
const CONTEXT_NOTE_MAX_CHARS = 8_000;

/** Rough token estimate: ~4 chars per token for text, actual usage for assistant messages */
function estimateMessageTokens(msg: AgentMessage): number {
  const m = msg as Message;
  if (m.role === "assistant") {
    const am = m as AssistantMessage;
    // Use output tokens as the message size estimate (NOT totalTokens which
    // includes input context and would make every assistant message appear as
    // 800k+ tokens, triggering runaway compaction)
    if (am.usage?.output) return am.usage.output;
  }
  // Estimate from content
  let chars = 0;
  if (m.role === "user") {
    if (typeof m.content === "string") {
      chars = m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "text") chars += c.text.length;
        else if (c.type === "image") chars += 1000; // ~250 tokens per image
      }
    }
  } else if (m.role === "assistant") {
    for (const c of m.content) {
      if (c.type === "text") chars += c.text.length;
      else if (c.type === "thinking") chars += (c as any).thinking?.length || 0;
    }
  } else if (m.role === "toolResult") {
    for (const c of m.content) {
      if (c.type === "text") chars += c.text.length;
      else if (c.type === "image") chars += 1000;
    }
  }
  return Math.ceil(chars / 4);
}

export interface ContextStats {
  totalTokens: number;
  messageCount: number;
  contextWindow: number;
  compactThreshold: number;
  usagePercent: number;
  pruningCount: number;
  compactionCount: number;
  compactions: number;
  sessionKey?: string;
}

const sessionCounters = new Map<string, { pruningCount: number; compactionCount: number }>();

function normalizeSessionKey(sessionKey?: string): string {
  return sessionKey || getAgentWeaveSession() || "max-main";
}

function getCounters(sessionKey: string): { pruningCount: number; compactionCount: number } {
  let counters = sessionCounters.get(sessionKey);
  if (!counters) {
    counters = { pruningCount: 0, compactionCount: 0 };
    sessionCounters.set(sessionKey, counters);
  }
  return counters;
}

export function getContextStats(messages: AgentMessage[], sessionKey?: string): ContextStats {
  const key = normalizeSessionKey(sessionKey);
  const counters = getCounters(key);
  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return {
    totalTokens,
    messageCount: messages.length,
    contextWindow: CONTEXT_WINDOW,
    compactThreshold: TOKEN_LIMIT,
    usagePercent: Math.round((totalTokens / CONTEXT_WINDOW) * 100),
    pruningCount: counters.pruningCount,
    compactionCount: counters.compactionCount,
    compactions: counters.compactionCount,
    sessionKey: key,
  };
}

function countPrunedToolResults(before: AgentMessage[], after: AgentMessage[]): number {
  let count = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    if (before[i] !== after[i] && (before[i] as Message).role === "toolResult") count++;
  }
  return count;
}

function messageText(msg: AgentMessage): string {
  const m = msg as Message;
  if (m.role === "user") {
    if (typeof m.content === "string") return m.content;
    return m.content
      .filter((c) => c.type === "text")
      .map((c) => (c as any).text)
      .join("\n");
  }
  if (m.role === "assistant") {
    return m.content
      .filter((c) => c.type === "text")
      .map((c) => (c as any).text)
      .join("\n");
  }
  return m.content
    .filter((c) => c.type === "text")
    .map((c) => (c as any).text)
    .join("\n");
}

function appendTextToUserMessage(msg: AgentMessage, note: string): AgentMessage {
  const m = msg as Message;
  if (m.role !== "user") return msg;
  if (typeof m.content === "string") {
    return { ...m, content: `${m.content}\n\n${note}` } as AgentMessage;
  }
  return { ...m, content: [...m.content, { type: "text", text: note }] } as AgentMessage;
}

function attachContextNoteToLatestUser(messages: AgentMessage[], note: string): AgentMessage[] {
  const trimmedNote = note.length > CONTEXT_NOTE_MAX_CHARS
    ? `${note.slice(0, CONTEXT_NOTE_MAX_CHARS)}\n[context note truncated]`
    : note;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as Message).role !== "user") continue;
    const out = messages.slice();
    out[i] = appendTextToUserMessage(messages[i], trimmedNote);
    return out;
  }
  return messages;
}

export function includeActiveBrief(messages: AgentMessage[], sessionKey?: string): AgentMessage[] {
  const key = normalizeSessionKey(sessionKey);
  const brief = getSessionBrief(key);
  if (!brief?.brief_md?.trim()) return messages;

  const latestUser = [...messages].reverse().find((msg) => (msg as Message).role === "user");
  const latestUserText = latestUser ? messageText(latestUser).trim() : "";
  if (brief.last_user_req && latestUserText && latestUserText === brief.last_user_req.trim()) {
    return messages;
  }

  const note = [
    "[Active session brief, for continuity only. The user's current request appears above.]",
    brief.brief_md.trim(),
    brief.current_objective ? `Current objective: ${brief.current_objective}` : "",
    brief.suggested_next.length > 0 ? `Suggested next: ${brief.suggested_next.join("; ")}` : "",
    brief.open_blockers ? `Open blockers: ${brief.open_blockers}` : "",
  ].filter(Boolean).join("\n");
  return attachContextNoteToLatestUser(messages, note);
}

/**
 * Compact context by summarizing old messages into a single summary message.
 * Keeps the most recent messages intact.
 *
 * Strategy (inspired by Claude Code / Aider):
 * - When over threshold, take the oldest messages (leaving KEEP_RECENT)
 * - Extract key information: tool calls made, results, decisions, errors
 * - Replace with a single compact user message containing the summary
 */
/**
 * Replace tool-result bodies older than the last `FRESH_TURNS` user turns with
 * a short stub. The result preserves the message structure (role, toolCallId,
 * isError) so tool_use ↔ tool_result pairing remains valid, but strips the
 * bulk of text content that would otherwise be re-sent to the model on every
 * subsequent iteration within the same session.
 *
 * Idempotent: a message whose content is already the stub marker is left alone.
 */
export function pruneStaleToolResults(
  messages: AgentMessage[],
  freshTurns = FRESH_TURNS
): AgentMessage[] {
  if (freshTurns <= 0 || messages.length === 0) return messages;

  // Identify the cut index: the index of the (freshTurns)th user message from the end.
  let seen = 0;
  let cutIdx = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as Message).role === "user") {
      seen++;
      if (seen === freshTurns) {
        cutIdx = i;
        break;
      }
    }
  }
  if (cutIdx <= 0) return messages; // nothing stale

  let changed = false;
  const out = messages.map((msg, idx) => {
    if (idx >= cutIdx) return msg;
    const m = msg as any;
    if (m.role !== "toolResult") return msg;
    if (!Array.isArray(m.content)) return msg;

    // Compute total text length; if already tiny, leave alone.
    let totalLen = 0;
    for (const c of m.content) {
      if (c.type === "text" && typeof c.text === "string") totalLen += c.text.length;
    }
    if (totalLen <= STALE_STUB_CHARS * 2) return msg; // already small

    const name = m.toolName || "tool";
    // Keep a short head prefix of the first text block (often contains path /
    // status / counts) to preserve a breadcrumb for the model.
    const firstText = m.content.find((c: any) => c.type === "text")?.text ?? "";
    const head = firstText.slice(0, STALE_STUB_CHARS).replace(/\s+/g, " ").trim();
    const stubText = `[${name} result — body pruned from context (${totalLen} chars). head: ${head}${head.length < firstText.length ? "…" : ""}]`;
    changed = true;
    return { ...m, content: [{ type: "text", text: stubText }] };
  });

  return changed ? out : messages;
}

export async function transformContext(messages: AgentMessage[], sessionKey?: string): Promise<AgentMessage[]> {
  logConfigOnce();
  const key = normalizeSessionKey(sessionKey);
  const counters = getCounters(key);

  // Cheap in-session pruning first — runs every turn, strips old toolResult
  // bodies so a long merge/debug session doesn't re-bill huge diffs forever.
  const beforePrune = messages;
  messages = pruneStaleToolResults(messages);
  const pruned = countPrunedToolResults(beforePrune, messages);
  if (pruned > 0) {
    counters.pruningCount += pruned;
    traceContextEvent("context.pruning", {
      "session.id": key,
      "prov.session.id": key,
      "context.pruned_tool_results": pruned,
      "context.pruning_count": counters.pruningCount,
    }, () => undefined);
    log("info", `Context pruning: pruned ${pruned} stale tool results for session ${key}`);
  }

  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  if (totalTokens <= TOKEN_LIMIT) {
    return includeActiveBrief(messages, key);
  }

  log("info", `Context compaction triggered for session ${key}: ${totalTokens} tokens > ${TOKEN_LIMIT} threshold (${messages.length} messages)`);

  // Find how many messages to compact — keep removing from front until under 50% of window
  const targetTokens = Math.floor(CONTEXT_WINDOW * 0.5);
  let keepFrom = messages.length - KEEP_RECENT;

  // Make sure we keep at least KEEP_RECENT
  if (keepFrom < 1) keepFrom = 1;

  // Walk backwards from keepFrom to find a good cut point under target
  let keptTokens = 0;
  for (let i = messages.length - 1; i >= keepFrom; i--) {
    keptTokens += estimateMessageTokens(messages[i]);
  }

  // If still over target, move keepFrom forward
  while (keepFrom < messages.length - KEEP_RECENT && keptTokens > targetTokens) {
    keepFrom++;
    keptTokens -= estimateMessageTokens(messages[keepFrom - 1]);
  }

  // Ensure toKeep starts at a user message boundary — orphaned toolResult or
  // assistant messages without their preceding context break model APIs.
  while (keepFrom < messages.length && (messages[keepFrom] as Message).role !== "user") {
    keepFrom++;
  }
  // If we couldn't find a user message, keep at least the last message
  if (keepFrom >= messages.length) keepFrom = messages.length - 1;

  const toCompact = messages.slice(0, keepFrom);
  const toKeep = messages.slice(keepFrom);

  if (toCompact.length === 0) return messages;

  // Build heuristic summary as fallback
  function buildHeuristicSummary(msgs: AgentMessage[]): string {
    const parts: string[] = ["[Context compacted — summary of earlier conversation:]"];
    for (const msg of msgs) {
      const m = msg as Message;
      if (m.role === "user") {
        const text = typeof m.content === "string"
          ? m.content
          : m.content.filter(c => c.type === "text").map(c => (c as any).text).join(" ");
        if (text.length > 0) {
          parts.push(`User: ${text.slice(0, 300)}${text.length > 300 ? "..." : ""}`);
        }
      } else if (m.role === "assistant") {
        const texts = m.content
          .filter(c => c.type === "text")
          .map(c => (c as any).text)
          .join(" ");
        const toolCalls = m.content
          .filter(c => c.type === "toolCall")
          .map(c => (c as any).name)
          .join(", ");
        if (toolCalls) {
          parts.push(`Assistant: [called: ${toolCalls}] ${texts.slice(0, 200)}${texts.length > 200 ? "..." : ""}`);
        } else if (texts.length > 0) {
          parts.push(`Assistant: ${texts.slice(0, 300)}${texts.length > 300 ? "..." : ""}`);
        }
      } else if (m.role === "toolResult") {
        const text = m.content.filter(c => c.type === "text").map(c => (c as any).text).join(" ");
        const status = (m as any).isError ? "ERROR" : "OK";
        parts.push(`Tool ${(m as any).toolName} [${status}]: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
      }
    }
    return parts.join("\n");
  }

  // Attempt LLM-generated summary
  async function buildLLMSummary(msgs: AgentMessage[]): Promise<string | null> {
    try {
      const defaultModel = process.env.DEFAULT_MODEL ?? "gemini-2.5-pro";
      const provider = defaultModel.startsWith("claude") ? "anthropic" : "google";
      const model = getModel(provider as any, defaultModel as any);
      if (!model) return null;

      const MAX_HISTORY_CHARS = 50_000;
      let historyText = buildHeuristicSummary(msgs);
      if (historyText.length > MAX_HISTORY_CHARS) {
        historyText = historyText.slice(0, MAX_HISTORY_CHARS) + "\n[...truncated]";
      }
      const prompt = `Summarize the following conversation history concisely. Focus on: decisions made, tools called and key outcomes, errors encountered, current state of any ongoing work, and any important context needed to continue. Be specific and include relevant values, paths, and statuses.\n\n${historyText}`;

      const apiKey = getEnvApiKey(provider as any);
      const stream = streamSimple(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { apiKey }
      );

      const LLM_TIMEOUT_MS = 30_000;
      const consumeStream = async (): Promise<string> => {
        let summary = "";
        for await (const event of stream) {
          if (event.type === "text_delta") {
            summary += event.delta;
          } else if (event.type === "done") {
            break;
          } else if (event.type === "error") {
            throw new Error(event.error?.errorMessage ?? "LLM compaction error");
          }
        }
        return summary;
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM compaction timed out after 30s")), LLM_TIMEOUT_MS)
      );
      const summary = await Promise.race([consumeStream(), timeout]);

      return summary.trim() || null;
    } catch (err) {
      log("warn", `LLM compaction summary failed, falling back to heuristic: ${err}`);
      return null;
    }
  }

  const timestamp = new Date().toISOString();
  const llmSummary = await buildLLMSummary(toCompact);
  const summaryText = llmSummary
    ? `[CONTEXT SUMMARY — compacted at ${timestamp}]\n\n${llmSummary}`
    : buildHeuristicSummary(toCompact);

  counters.compactionCount++;
  const compacted = attachContextNoteToLatestUser(toKeep, summaryText);
  const withBrief = includeActiveBrief(compacted, key);
  const newTokens = withBrief.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  traceContextEvent("context.compaction", {
    "session.id": key,
    "prov.session.id": key,
    "context.tokens_before": totalTokens,
    "context.tokens_after": newTokens,
    "context.messages_before": messages.length,
    "context.messages_after": withBrief.length,
    "context.compaction_count": counters.compactionCount,
  }, () => undefined);
  log("info", `Context compacted for session ${key}: ${toCompact.length} messages summarized. ${messages.length} → ${withBrief.length} messages. ${totalTokens} → ~${newTokens} tokens. Compaction #${counters.compactionCount}`);

  return withBrief;
}
