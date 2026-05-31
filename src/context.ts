import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { getModel, getEnvApiKey, streamSimple } from "@mariozechner/pi-ai";
import { log } from "./logger.js";
import { getSessionContext } from "./agentweave-context.js";
import { getActiveBrief, getSessionSummary, setSessionSummary, type SessionActiveBrief } from "./session.js";
import { traceContextCompaction } from "./tracing.js";

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
const FRESH_TURNS = Math.floor(Number(process.env.MAX_FRESH_TURNS || 4));
const STALE_STUB_CHARS = 200;
const ACTIVE_BRIEF_MAX_AGE_MS = envNumber("MAX_ACTIVE_BRIEF_MAX_AGE_MS", 48 * 60 * 60 * 1000);

/** Rough token estimate: ~4 chars per token for text, actual usage for assistant messages */
function estimateMessageTokens(msg: AgentMessage): number {
  const m = msg as Message;
  if (m.role === "assistant") {
    const am = m as AssistantMessage;
    if (am.usage?.output) return am.usage.output;
  }

  let chars = 0;
  if (m.role === "user") {
    if (typeof m.content === "string") {
      chars = m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "text") chars += c.text.length;
        else if (c.type === "image") chars += 1000;
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
  compactions: number;
  prunedToolResults: number;
  sessionKey?: string;
}

export interface TransformContextOptions {
  sessionKey?: string;
  includeActiveBrief?: boolean;
  includeSessionSummary?: boolean;
  reason?: "casual" | "long_running" | "post_compaction" | "manual";
  disableLlmSummary?: boolean;
  now?: number;
}

export interface RequestContextResult {
  messages: AgentMessage[];
  stats: ContextStats;
  compacted: boolean;
  compactedMessages: number;
}

let compactionCount = 0;

export function getContextStats(messages: AgentMessage[], sessionKey?: string): ContextStats {
  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return {
    totalTokens,
    messageCount: messages.length,
    contextWindow: CONTEXT_WINDOW,
    compactThreshold: TOKEN_LIMIT,
    usagePercent: Math.round((totalTokens / CONTEXT_WINDOW) * 100),
    compactions: compactionCount,
    prunedToolResults: countPrunedToolResultStubs(messages),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function countPrunedToolResultStubs(messages: AgentMessage[]): number {
  return messages.filter((msg) => {
    const m = msg as any;
    return m.role === "toolResult" && Array.isArray(m.content) &&
      m.content.some((c: any) => c.type === "text" && typeof c.text === "string" && c.text.includes("body pruned from context"));
  }).length;
}

interface PruneResult {
  messages: AgentMessage[];
  prunedCount: number;
}

function pruneStaleToolResultsWithStats(messages: AgentMessage[], freshTurns = FRESH_TURNS): PruneResult {
  if (freshTurns <= 0 || messages.length === 0) return { messages, prunedCount: 0 };

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
  if (cutIdx <= 0) return { messages, prunedCount: 0 };

  let changed = false;
  let prunedCount = 0;
  const out = messages.map((msg, idx) => {
    if (idx >= cutIdx) return msg;
    const m = msg as any;
    if (m.role !== "toolResult") return msg;
    if (!Array.isArray(m.content)) return msg;

    let totalLen = 0;
    for (const c of m.content) {
      if (c.type === "text" && typeof c.text === "string") totalLen += c.text.length;
    }
    if (totalLen <= STALE_STUB_CHARS * 2) return msg;

    const firstText = m.content.find((c: any) => c.type === "text")?.text ?? "";
    if (typeof firstText === "string" && firstText.includes("body pruned from context")) return msg;

    const name = m.toolName || "tool";
    const head = firstText.slice(0, STALE_STUB_CHARS).replace(/\s+/g, " ").trim();
    const stubText = `[${name} result — body pruned from context (${totalLen} chars). head: ${head}${head.length < firstText.length ? "…" : ""}]`;
    changed = true;
    prunedCount++;
    return { ...m, content: [{ type: "text", text: stubText }] };
  });

  return { messages: changed ? out : messages, prunedCount };
}

/**
 * Replace tool-result bodies older than the last `FRESH_TURNS` user turns with
 * a short stub. This is request-context pruning only; durable history should be
 * left to session storage policy rather than rewritten for one model call.
 */
export function pruneStaleToolResults(
  messages: AgentMessage[],
  freshTurns = FRESH_TURNS
): AgentMessage[] {
  return pruneStaleToolResultsWithStats(messages, freshTurns).messages;
}

function extractText(msg: AgentMessage): string {
  const m = msg as Message;
  if (m.role === "user") {
    return typeof m.content === "string"
      ? m.content
      : m.content.filter((c) => c.type === "text").map((c) => (c as any).text).join(" ");
  }
  if (m.role === "assistant" || m.role === "toolResult") {
    return m.content.filter((c) => c.type === "text").map((c) => (c as any).text).join(" ");
  }
  return "";
}

function buildHeuristicSummary(msgs: AgentMessage[]): string {
  const parts: string[] = ["[Context summary — earlier conversation, not a new user request:]"];
  for (const msg of msgs) {
    const m = msg as Message;
    if (m.role === "user") {
      const text = extractText(msg);
      if (text.length > 0) parts.push(`User: ${text.slice(0, 300)}${text.length > 300 ? "..." : ""}`);
    } else if (m.role === "assistant") {
      const texts = extractText(msg);
      const toolCalls = m.content
        .filter((c) => c.type === "toolCall")
        .map((c) => (c as any).name)
        .join(", ");
      if (toolCalls) parts.push(`Assistant: [called: ${toolCalls}] ${texts.slice(0, 200)}${texts.length > 200 ? "..." : ""}`);
      else if (texts.length > 0) parts.push(`Assistant: ${texts.slice(0, 300)}${texts.length > 300 ? "..." : ""}`);
    } else if (m.role === "toolResult") {
      const text = extractText(msg);
      const status = (m as any).isError ? "ERROR" : "OK";
      parts.push(`Tool ${(m as any).toolName} [${status}]: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
    }
  }
  return parts.join("\n");
}

async function buildLLMSummary(msgs: AgentMessage[]): Promise<string | null> {
  try {
    const defaultModel = process.env.DEFAULT_MODEL ?? "gemini-2.5-pro";
    const provider = defaultModel.startsWith("claude") ? "anthropic" : "google";
    const model = getModel(provider as any, defaultModel as any);
    if (!model) return null;

    const MAX_HISTORY_CHARS = 50_000;
    let historyText = buildHeuristicSummary(msgs);
    if (historyText.length > MAX_HISTORY_CHARS) historyText = historyText.slice(0, MAX_HISTORY_CHARS) + "\n[...truncated]";
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
        if (event.type === "text_delta") summary += event.delta;
        else if (event.type === "done") break;
        else if (event.type === "error") throw new Error(event.error?.errorMessage ?? "LLM compaction error");
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

function summaryMessage(summary: string, timestamp: string): AgentMessage {
  return {
    role: "user",
    content: `[CONTEXT SUMMARY — compacted at ${timestamp}; not a new user request]\n\n${summary}`,
    timestamp: Date.now(),
  } as AgentMessage;
}

function activeBriefMessage(brief: SessionActiveBrief): AgentMessage {
  const lines = ["[ACTIVE SESSION BRIEF — continuity context, not a new user request]", brief.brief_md];
  if (brief.last_user_req) lines.push(`Last user request: ${brief.last_user_req}`);
  if (brief.current_objective) lines.push(`Current objective: ${brief.current_objective}`);
  if (brief.suggested_next?.length) lines.push(`Suggested next: ${brief.suggested_next.join("; ")}`);
  if (brief.files_touched?.length) lines.push(`Files touched: ${brief.files_touched.join(", ")}`);
  if (brief.open_blockers) lines.push(`Open blockers: ${brief.open_blockers}`);
  return { role: "user", content: lines.filter(Boolean).join("\n"), timestamp: Date.now() } as AgentMessage;
}

function shouldIncludeActiveBrief(brief: SessionActiveBrief | undefined, options: TransformContextOptions): brief is SessionActiveBrief {
  if (!brief) return false;
  const useful = Boolean(brief.brief_md || brief.current_objective || brief.open_blockers || brief.files_touched?.length);
  if (!useful) return false;
  const ageMs = (options.now ?? Date.now()) - (brief.updated_at ?? 0);
  if (ageMs > ACTIVE_BRIEF_MAX_AGE_MS) return false;
  return options.includeActiveBrief === true || options.reason === "long_running" || options.reason === "post_compaction" || options.reason === "manual";
}

export async function buildRequestContext(messages: AgentMessage[], options: TransformContextOptions = {}): Promise<RequestContextResult> {
  logConfigOnce();

  const beforeMessages = messages.length;
  const beforeTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const pruned = pruneStaleToolResultsWithStats(messages);
  messages = pruned.messages;

  const storedSummary = options.sessionKey && options.includeSessionSummary !== false ? getSessionSummary(options.sessionKey) : undefined;
  const storedSummaryMessage = storedSummary ? summaryMessage(storedSummary, "stored") : undefined;
  const activeBrief = options.sessionKey ? getActiveBrief(options.sessionKey) : undefined;
  const includeBriefBeforeCompaction = shouldIncludeActiveBrief(activeBrief, options);

  let totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  if (storedSummaryMessage) totalTokens += estimateMessageTokens(storedSummaryMessage);
  if (includeBriefBeforeCompaction) totalTokens += estimateMessageTokens(activeBriefMessage(activeBrief));

  if (totalTokens <= TOKEN_LIMIT) {
    const prefix: AgentMessage[] = [];
    if (storedSummaryMessage) prefix.push(storedSummaryMessage);
    if (includeBriefBeforeCompaction) prefix.push(activeBriefMessage(activeBrief));
    const out = prefix.length > 0 ? [...prefix, ...messages] : messages;
    return {
      messages: out,
      stats: getContextStats(out, options.sessionKey),
      compacted: false,
      compactedMessages: 0,
    };
  }

  log("info", `Context compaction triggered: ${totalTokens} tokens > ${TOKEN_LIMIT} threshold (${messages.length} messages, session=${options.sessionKey ?? "unknown"})`);

  const targetTokens = Math.floor(CONTEXT_WINDOW * 0.5);
  let keepFrom = messages.length - KEEP_RECENT;
  if (keepFrom < 1) keepFrom = 1;

  let keptTokens = 0;
  for (let i = messages.length - 1; i >= keepFrom; i--) keptTokens += estimateMessageTokens(messages[i]);
  while (keepFrom < messages.length - KEEP_RECENT && keptTokens > targetTokens) {
    keepFrom++;
    keptTokens -= estimateMessageTokens(messages[keepFrom - 1]);
  }
  while (keepFrom < messages.length && (messages[keepFrom] as Message).role !== "user") keepFrom++;
  if (keepFrom >= messages.length) keepFrom = messages.length - 1;

  const toCompact = messages.slice(0, keepFrom);
  const toKeep = messages.slice(keepFrom);
  if (toCompact.length === 0) {
    return { messages, stats: getContextStats(messages, options.sessionKey), compacted: false, compactedMessages: 0 };
  }

  const timestamp = new Date().toISOString();
  const llmSummary = options.disableLlmSummary ? null : await buildLLMSummary(toCompact);
  const summaryText = llmSummary ?? buildHeuristicSummary(toCompact);
  if (options.sessionKey) setSessionSummary(options.sessionKey, summaryText);

  compactionCount++;
  const summary = summaryMessage(summaryText, timestamp);
  const postCompactionBrief = shouldIncludeActiveBrief(activeBrief, { ...options, reason: options.reason ?? "post_compaction" })
    ? activeBriefMessage(activeBrief)
    : undefined;
  const out = postCompactionBrief ? [summary, postCompactionBrief, ...toKeep] : [summary, ...toKeep];
  const afterTokens = out.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  traceContextCompaction({
    sessionKey: options.sessionKey,
    beforeTokens,
    afterTokens,
    beforeMessages,
    afterMessages: out.length,
    prunedToolResults: pruned.prunedCount,
    compactedMessages: toCompact.length,
    compactionCount,
  }, () => {
    log("info", `Context compacted: ${toCompact.length} messages → session summary. ${beforeMessages} → ${out.length} messages. ${beforeTokens} → ~${afterTokens} tokens. Compaction #${compactionCount} session=${options.sessionKey ?? "unknown"}`);
  });

  return {
    messages: out,
    stats: getContextStats(out, options.sessionKey),
    compacted: true,
    compactedMessages: toCompact.length,
  };
}

export async function transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  const result = await buildRequestContext(messages, { sessionKey: getSessionContext().sessionKey });
  return result.messages;
}
