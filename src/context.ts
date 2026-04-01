import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { getModel, getEnvApiKey, streamSimple } from "@mariozechner/pi-ai";
import { log } from "./logger.js";

const CONTEXT_WINDOW = 1_000_000;
const COMPACT_THRESHOLD = 0.8; // compact at 80%
const TOKEN_LIMIT = Math.floor(CONTEXT_WINDOW * COMPACT_THRESHOLD);
// Keep at least the last N messages untouched during compaction
const KEEP_RECENT = 6;

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
  compactions: number;
}

let compactionCount = 0;

export function getContextStats(messages: AgentMessage[]): ContextStats {
  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return {
    totalTokens,
    messageCount: messages.length,
    contextWindow: CONTEXT_WINDOW,
    compactThreshold: TOKEN_LIMIT,
    usagePercent: Math.round((totalTokens / CONTEXT_WINDOW) * 100),
    compactions: compactionCount,
  };
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
export async function transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  if (totalTokens <= TOKEN_LIMIT) {
    return messages;
  }

  log("info", `Context compaction triggered: ${totalTokens} tokens > ${TOKEN_LIMIT} threshold (${messages.length} messages)`);

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
      const defaultModel = process.env.DEFAULT_MODEL || "gemini-2.5-pro";
      const provider = defaultModel.startsWith("claude") ? "anthropic" : "google";
      const model = getModel(provider as any, defaultModel as any);
      if (!model) return null;

      const historyText = buildHeuristicSummary(msgs);
      const prompt = `Summarize the following conversation history concisely. Focus on: decisions made, tools called and key outcomes, errors encountered, current state of any ongoing work, and any important context needed to continue. Be specific and include relevant values, paths, and statuses.\n\n${historyText}`;

      const apiKey = getEnvApiKey(provider as any);
      const stream = streamSimple(
        model,
        { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { apiKey }
      );
      let summary = "";
      for await (const event of stream) {
        if (event.type === "text_delta") {
          summary += event.delta;
        } else if (event.type === "done") {
          // finished
          break;
        } else if (event.type === "error") {
          throw new Error(event.error?.errorMessage ?? "LLM compaction error");
        }
      }
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
  const summaryMessage: AgentMessage = {
    role: "user",
    content: summaryText,
    timestamp: Date.now(),
  };

  compactionCount++;
  const newTokens = toKeep.reduce((sum, m) => sum + estimateMessageTokens(m), 0) + estimateMessageTokens(summaryMessage);
  log("info", `Context compacted: ${toCompact.length} messages → summary. ${messages.length} → ${toKeep.length + 1} messages. ${totalTokens} → ~${newTokens} tokens. Compaction #${compactionCount}`);

  return [summaryMessage, ...toKeep];
}
