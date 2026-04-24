import { Bot, Context, InputFile } from "grammy";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { writeMemoryEvent } from "./memory.js";
import { createTask, updateTaskStatus, getRecentTasks } from "./task-journal.js";
import { log } from "./logger.js";
import { traceAgentTurn } from "./tracing.js";
import { saveSession, clearSession } from "./session.js";
import { extractAssistantTextFromTurn, extractErrorFromTurn } from "./response.js";

// ── Deduplication — Issue #2 ─────────────────────────────────────────────────
const processedUpdateIds = new Set<number>();
const MAX_PROCESSED_IDS = 500;

function markProcessed(updateId: number): boolean {
  if (processedUpdateIds.has(updateId)) return false; // already seen
  processedUpdateIds.add(updateId);
  if (processedUpdateIds.size > MAX_PROCESSED_IDS) {
    // Remove oldest entry (Sets preserve insertion order)
    processedUpdateIds.delete(processedUpdateIds.values().next().value!);
  }
  return true; // first time seeing this
}
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean);

const STREAM_EDIT_INTERVAL_MS = 1200;
const TYPING_INTERVAL_MS = 4000;
const STATUS_MIN_INTERVAL_MS = 800; // min gap between status edits to avoid Telegram 429
const MAX_MSG_LEN = 4000;

interface ConversationEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

const conversationHistory: ConversationEntry[] = [];
const MAX_HISTORY = 20;

function isAllowed(ctx: Context): boolean {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(String(ctx.from?.id));
}

function trimHistory() {
  while (conversationHistory.length > MAX_HISTORY) {
    conversationHistory.shift();
  }
}

/**
 * Convert Markdown to Telegram-compatible HTML.
 *
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>,
 * <tg-spoiler>, and <tg-emoji>. No <h1>-<h6>, <ul>, <li>, <p>.
 *
 * Strategy: extract protected blocks first (code blocks, inline code),
 * transform markdown in remaining text, then reassemble.
 */
function mdToHtml(md: string): string {
  // 1. Extract code blocks and inline code to protect from further processing
  const codeBlocks: string[] = [];
  let html = md;

  // Code blocks: ```lang\n...\n``` → placeholder
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = code.trimEnd().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const langAttr = lang ? ` class="language-${lang}"` : "";
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Inline code: `...` → placeholder
  html = html.replace(/`([^`\n]+)`/g, (_m, code) => {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    codeBlocks.push(`<code>${escaped}</code>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Escape HTML entities in remaining text
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 3. Blockquotes: > text → <blockquote>text</blockquote>
  // Handle multi-line blockquotes (consecutive > lines)
  html = html.replace(/^(?:&gt;\s?.+\n?)+/gm, (block) => {
    const inner = block.replace(/^&gt;\s?/gm, "").trim();
    return `<blockquote>${inner}</blockquote>`;
  });

  // 4. Bold: **text** (must come before italic)
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 5. Italic: *text* (not bullet points — require non-newline content)
  html = html.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "<i>$1</i>");

  // 6. Underline: __text__ (before single _ italic)
  html = html.replace(/__(.+?)__/g, "<u>$1</u>");

  // 7. Italic: _text_ (not inside words)
  html = html.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "<i>$1</i>");

  // 8. Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 9. Headings: # text → bold (Telegram has no heading tags)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "\n<b>$1</b>");

  // 10. Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 11. Bullet lists: - item or * item → • item (only at line start, with optional indent)
  html = html.replace(/^(\s*)[-*]\s+/gm, (_m, indent) => {
    const depth = Math.floor(indent.length / 2);
    const prefix = depth > 0 ? "  ".repeat(depth) : "";
    return `${prefix}• `;
  });

  // 12. Numbered lists: 1. item → 1. item (keep as-is, they look fine)

  // 13. Horizontal rules: --- or *** → divider line
  html = html.replace(/^[-*]{3,}$/gm, "───────────────");

  // 14. Restore code blocks
  html = html.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);

  // 15. Clean up excessive blank lines
  html = html.replace(/\n{3,}/g, "\n\n");

  return html.trim();
}

/**
 * Try sending/editing with HTML parse_mode, fall back to plain text if it fails.
 */
async function editWithFormat(
  bot: Bot,
  chatId: number,
  messageId: number,
  text: string,
  useHtml: boolean = true
): Promise<void> {
  if (useHtml) {
    try {
      await bot.api.editMessageText(chatId, messageId, mdToHtml(text), { parse_mode: "HTML" });
      return;
    } catch (e: any) {
      if (e.message?.includes("message is not modified")) return;
      // HTML parse failed — fall back to plain text
      log("warn", `HTML edit failed, falling back to plain: ${e.message}`);
    }
  }
  try {
    await bot.api.editMessageText(chatId, messageId, text);
  } catch (e: any) {
    if (!e.message?.includes("message is not modified")) {
      log("warn", `Plain edit also failed: ${e.message}`);
    }
  }
}

async function replyWithFormat(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(mdToHtml(text), { parse_mode: "HTML" });
  } catch {
    await ctx.reply(text);
  }
}

async function sendWithFormat(bot: Bot, chatId: number, text: string): Promise<number> {
  try {
    const msg = await bot.api.sendMessage(chatId, mdToHtml(text), { parse_mode: "HTML" });
    return msg.message_id;
  } catch {
    const msg = await bot.api.sendMessage(chatId, text);
    return msg.message_id;
  }
}

const TOOL_LABELS: Record<string, string> = {
  delegate_to_nix: "🔗 Asking Nix",
  wake_gpu: "⚡ Waking GPU",
  shutdown_gpu: "🔌 Shutting down GPU",
  gpu_status: "📊 Checking GPU",
  read_file: "📄 Reading file",
  write_file: "✏️ Writing file",
  list_files: "📁 Listing files",
  ssh_to_nas: "🖥️ Running on NAS",
  browser_control: "🌐 Controlling browser",
  linkedin_search: "🔍 Searching LinkedIn",
  linkedin_results: "📋 Reading LinkedIn results",
  ios_list_devices: "📱 Listing devices",
  ios_build: "🔨 Building iOS app",
  ios_install: "📲 Installing on device",
  ios_build_and_deploy: "🚀 Building & deploying iOS",
  launchpad_run_scraper: "🕷️ Running Launchpad scraper",
  launchpad_deploy: "🚢 Deploying Launchpad",
  run_shell: "💻 Running command",
  delegate_to_claude_subagent: "🤖 Delegating to Claude subagent",
  context_info: "📊 Checking context",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function createTelegramBot(agent: Agent): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  const bot = new Bot(token);

  bot.command("status", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const streaming = agent.state.isStreaming;
    await ctx.reply(`Agent: online\nUptime: ${h}h ${m}m\nStreaming: ${streaming}\nMessages in context: ${agent.state.messages.length}`);
  });

  bot.command("tasks", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const tasks = getRecentTasks(5);
    if (tasks.length === 0) {
      await ctx.reply("No recent tasks.");
      return;
    }
    const lines = tasks.map((t) => {
      const age = Math.round((Date.now() - t.created_at) / 60000);
      return `[${t.status}] ${t.type} from ${t.source} (${age}m ago)`;
    });
    await ctx.reply(lines.join("\n"));
  });

  bot.command("memory", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const today = new Date().toISOString().slice(0, 10);
    const { readFile } = await import("fs/promises");
    const path = await import("path");
    try {
      const content = await readFile(path.join(process.env.HOME!, "max", "memory", `${today}.md`), "utf-8");
      await replyWithFormat(ctx, content.slice(0, 4000) || "No memory entries today.");
    } catch {
      await ctx.reply("No memory file for today yet.");
    }
  });

  bot.command("clear", async (ctx) => {
    if (!isAllowed(ctx)) return;
    conversationHistory.length = 0;
    agent.clearMessages();
    clearSession();
    await ctx.reply("Conversation context cleared.");
  });

  // Core message handler — processes text with optional images
  async function handleMessage(ctx: Context, text: string, images?: { type: "image"; data: string; mimeType: string }[]) {
    // If agent is already running a request, abort it and wait for completion
    if (agent.state.isStreaming) {
      log("info", "Aborting previous agent run before starting new request");
      agent.abort();
      const abortDeadline = Date.now() + 5000;
      while (agent.state.isStreaming && Date.now() < abortDeadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (agent.state.isStreaming) {
        log("warn", "Abort timed out, agent still streaming");
        await ctx.reply("⏳ Max is still busy with a previous task. Please wait a moment.");
        return;
      }
    }

    log("info", `Telegram message from ${ctx.from?.id}: ${text.slice(0, 100)}${images?.length ? ` (+${images.length} image${images.length > 1 ? "s" : ""})` : ""}`);

    conversationHistory.push({ role: "user", text, timestamp: Date.now() });
    trimHistory();

    const task = createTask("telegram_msg", "telegram", { text, from: ctx.from?.id, hasImages: !!images?.length });
    updateTaskStatus(task.id, "working");

    // Send placeholder message (plain text, no parse_mode)
    const placeholder = await ctx.reply("⏳ Thinking...");
    const chatId = placeholder.chat.id;
    const messageId = placeholder.message_id;

    let responseText = "";
    let lastEditedText = "⏳ Thinking...";
    let lastAnswerEditedText = "";
    let statusLabel = "⏳ Thinking";
    let spinnerIdx = 0;
    let editTimer: ReturnType<typeof setInterval> | null = null;
    let typingTimer: ReturnType<typeof setInterval> | null = null;
    let isStreaming = false;
    let lastStatusEditAt = 0;
    let pendingStatusEdit: ReturnType<typeof setTimeout> | null = null;
    const pendingImages: { data: string; mimeType: string; caption?: string }[] = [];
    // Collapsed tool log: consecutive duplicates merged to "<entry> (×N)"
    const toolLog: { entry: string; count: number }[] = [];

    // Status bubble (edits only, no notifications) vs. answer bubble (new message → push notification)
    const statusMsgId = messageId;
    let currentMsgId: number | null = null; // answer bubble — created lazily on first text delta
    const allChunks: string[] = []; // finalized chunks for history reconstruction

    // Rate-limited status edit — always targets the status bubble (statusMsgId).
    // Answer streaming lives in its own bubble (currentMsgId), so status keeps updating
    // even after the answer starts arriving.
    const editStatus = (newLabel: string) => {
      statusLabel = newLabel;

      const now = Date.now();
      const elapsed = now - lastStatusEditAt;

      const doEdit = async () => {
        spinnerIdx = (spinnerIdx + 1) % SPINNER.length;
        const displayText = buildStatusText();
        if (displayText === lastEditedText) return;
        try {
          await bot.api.editMessageText(chatId, statusMsgId, displayText);
          lastEditedText = displayText;
          lastStatusEditAt = Date.now();
        } catch (e: any) {
          if (!e.message?.includes("message is not modified")) {
            log("warn", `Status edit failed: ${e.message}`);
          }
        }
      };

      if (pendingStatusEdit) {
        clearTimeout(pendingStatusEdit);
        pendingStatusEdit = null;
      }

      if (elapsed >= STATUS_MIN_INTERVAL_MS) {
        doEdit();
      } else {
        pendingStatusEdit = setTimeout(doEdit, STATUS_MIN_INTERVAL_MS - elapsed);
      }
    };

    // Build the status display text with spinner and tool log
    const buildStatusText = (): string => {
      const spinner = SPINNER[spinnerIdx];
      const lines: string[] = [];
      for (const { entry, count } of toolLog) {
        lines.push(count > 1 ? `${entry} (×${count})` : entry);
      }
      // If the answer has started streaming, drop the spinner line to avoid
      // duplicating it below the (separate) answer bubble.
      if (!isStreaming) lines.push(`${spinner} ${statusLabel}...`);
      return lines.join("\n") || `${spinner} ${statusLabel}...`;
    };

    // Append a completed tool entry, collapsing consecutive duplicates.
    const appendToolEntry = (entry: string) => {
      const last = toolLog[toolLog.length - 1];
      if (last && last.entry === entry) {
        last.count += 1;
      } else {
        toolLog.push({ entry, count: 1 });
      }
    };

    // Keep typing indicator alive
    typingTimer = setInterval(() => {
      bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, TYPING_INTERVAL_MS);
    bot.api.sendChatAction(chatId, "typing").catch(() => {});

    // Spinner animation + stream text edits (with rolling message split)
    const startEditing = () => {
      editTimer = setInterval(async () => {
        if (responseText.length > 0) {
          // Lazy-create the answer bubble on first text delta → push notification fires.
          if (currentMsgId === null) {
            try {
              const display = responseText + " ▍";
              currentMsgId = await sendWithFormat(bot, chatId, display);
              lastAnswerEditedText = responseText;
            } catch (e: any) {
              log("warn", `Failed to send answer message: ${e.message}`);
            }
            return;
          }

          // Streaming text — check if we need to split into a new message
          if (responseText.length > MAX_MSG_LEN) {
            const splitAt = findSplitPoint(responseText, MAX_MSG_LEN);
            const chunk = responseText.slice(0, splitAt);
            const remainder = responseText.slice(splitAt).trimStart();

            await editWithFormat(bot, chatId, currentMsgId, chunk);
            allChunks.push(chunk);

            try {
              await new Promise(r => setTimeout(r, 200));
              const newMsgId = await sendWithFormat(bot, chatId, remainder + " ▍");
              currentMsgId = newMsgId;
              responseText = remainder;
              lastAnswerEditedText = remainder;
            } catch (e: any) {
              log("warn", `Failed to send continuation message: ${e.message}`);
            }
            return;
          }

          // Normal streaming edit
          if (responseText === lastAnswerEditedText) return;
          const display = responseText + " ▍";

          try {
            await bot.api.editMessageText(chatId, currentMsgId, mdToHtml(display), { parse_mode: "HTML" });
            lastAnswerEditedText = responseText;
          } catch (e: any) {
            if (e.message?.includes("message is not modified")) return;
            try {
              await bot.api.editMessageText(chatId, currentMsgId, display);
              lastAnswerEditedText = responseText;
            } catch (e2: any) {
              if (!e2.message?.includes("message is not modified")) {
                log("warn", `Edit failed: ${e2.message}`);
              }
            }
          }
        } else {
          // Animate spinner while waiting
          editStatus(statusLabel);
        }
      }, STREAM_EDIT_INTERVAL_MS);
    };

    try {
      const unsub = agent.subscribe((event: AgentEvent) => {
        switch (event.type) {
          case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
              responseText += event.assistantMessageEvent.delta;
              if (!isStreaming) {
                isStreaming = true;
                log("info", "Streaming started");
              }
            }
            break;
          case "tool_execution_start": {
            const label = TOOL_LABELS[event.toolName] || `🔧 ${event.toolName}`;
            log("info", `Tool started: ${event.toolName}`);
            editStatus(label);
            break;
          }
          case "tool_execution_end": {
            const label = TOOL_LABELS[event.toolName] || `🔧 ${event.toolName}`;
            const icon = event.isError ? "❌" : "✅";
            appendToolEntry(`${icon} ${label}`);
            log("info", `Tool ended: ${event.toolName} (error: ${event.isError})`);
            // Capture image results for sending as photos
            if (!event.isError && event.result?.content) {
              for (const item of event.result.content) {
                if (item.type === "image" && item.data) {
                  const caption = event.result.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join(" ")
                    .slice(0, 200) || undefined;
                  pendingImages.push({ data: item.data, mimeType: item.mimeType, caption });
                }
              }
            }
            // Show "done" briefly then back to thinking
            editStatus(`${icon} ${label}`);
            setTimeout(() => {
              if (responseText.length === 0) {
                editStatus("⏳ Thinking");
              }
            }, 1500);
            break;
          }
          case "turn_start":
            if (responseText.length === 0) {
              editStatus("⏳ Thinking");
            } else {
              // Separate text from consecutive turns with a blank line
              if (!responseText.endsWith("\n\n")) {
                responseText += responseText.endsWith("\n") ? "\n" : "\n\n";
              }
            }
            break;
        }
      });

      const turnStartIndex = agent.state.messages.length;
      startEditing();
      await agent.prompt(text, images);
      unsub();

      if (editTimer) clearInterval(editTimer);
      if (typingTimer) clearInterval(typingTimer);
      if (pendingStatusEdit) clearTimeout(pendingStatusEdit);

      if (!responseText) {
        responseText = extractAssistantTextFromTurn(agent.state.messages as any, turnStartIndex);
      }

      if (!responseText) {
        const llmError = extractErrorFromTurn(agent.state.messages as any, turnStartIndex);
        if (llmError) {
          log("warn", `LLM error during prompt: ${llmError}`);
          updateTaskStatus(task.id, "failed", { error: llmError });
          responseText = `LLM error: ${llmError}`;
        } else {
          const msgCount = agent.state.messages.length;
          const lastRole = msgCount > 0 ? (agent.state.messages[msgCount - 1] as any).role : "none";
          log("warn", `Empty response after prompt. Messages: ${msgCount}, last role: ${lastRole}`);
          responseText = "(no response)";
        }
      }

      // Finalize status bubble: drop the live spinner, leaving just the tool log.
      // If nothing happened (no tools), collapse the status bubble to a one-liner.
      try {
        const statusFinal = toolLog.length > 0
          ? toolLog.map(({ entry, count }) => (count > 1 ? `${entry} (×${count})` : entry)).join("\n")
          : "✅ Done";
        if (statusFinal !== lastEditedText) {
          await bot.api.editMessageText(chatId, statusMsgId, statusFinal);
        }
      } catch (e: any) {
        if (!e.message?.includes("message is not modified")) {
          log("warn", `Final status edit failed: ${e.message}`);
        }
      }

      // Finalize the answer. If we never opened an answer bubble (e.g. tool-only turn,
      // or the response arrived after streaming ended), send it as a new message so a
      // push notification fires.
      if (responseText.length <= MAX_MSG_LEN) {
        if (currentMsgId === null) {
          currentMsgId = await sendWithFormat(bot, chatId, responseText);
        } else {
          await editWithFormat(bot, chatId, currentMsgId, responseText);
        }
      } else {
        const chunks = splitMessage(responseText, MAX_MSG_LEN);
        if (currentMsgId === null) {
          currentMsgId = await sendWithFormat(bot, chatId, chunks[0]);
        } else {
          await editWithFormat(bot, chatId, currentMsgId, chunks[0]);
        }
        for (let i = 1; i < chunks.length; i++) {
          await replyWithFormat(ctx, chunks[i]);
        }
      }

      // Reconstruct full response for conversation history
      if (allChunks.length > 0) {
        allChunks.push(responseText);
        responseText = allChunks.join("");
      }

      // Send any captured images as photos
      for (const img of pendingImages) {
        try {
          const buf = Buffer.from(img.data, "base64");
          await bot.api.sendPhoto(chatId, new InputFile(buf, "screenshot.png"), {
            caption: img.caption,
          });
        } catch (e: any) {
          log("warn", `Failed to send image: ${e.message}`);
        }
      }

      conversationHistory.push({ role: "assistant", text: responseText, timestamp: Date.now() });
      trimHistory();

      updateTaskStatus(task.id, "completed", { response: responseText.slice(0, 500) });
      saveSession(agent);
      await writeMemoryEvent(`Telegram conversation with user ${ctx.from?.id}: "${text.slice(0, 80)}"`);
    } catch (e: any) {
      if (editTimer) clearInterval(editTimer);
      if (typingTimer) clearInterval(typingTimer);
      if (pendingStatusEdit) clearTimeout(pendingStatusEdit);
      agent.abort(); // stop runaway background execution
      log("error", `Agent error: ${e.message}`);
      updateTaskStatus(task.id, "failed", { error: e.message });
      try {
        if (currentMsgId !== null) {
          await bot.api.editMessageText(chatId, currentMsgId, `❌ Error: ${e.message}`);
        } else {
          await ctx.reply(`❌ Error: ${e.message}`);
        }
      } catch {
        await ctx.reply(`❌ Error: ${e.message}`);
      }
    }
  }

  // Text messages
  bot.on("message:text", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const updateId = ctx.update.update_id;
    if (!markProcessed(updateId)) {
      log("warn", `Duplicate update ${updateId} ignored`);
      return;
    }
    const sessionId = `tg-${ctx.chat.id}`;
    const telegramMessageId = ctx.message.message_id;
    const chatId = ctx.chat.id;
    await traceAgentTurn("handleMessage", async () => {
      await handleMessage(ctx, ctx.message.text);
    }, { sessionId, telegramMessageId, chatId });
  });

  // Photo messages (with optional caption)
  bot.on("message:photo", async (ctx) => {
    if (!isAllowed(ctx)) return;
    const updateId = ctx.update.update_id;
    if (!markProcessed(updateId)) {
      log("warn", `Duplicate update ${updateId} ignored`);
      return;
    }

    const caption = ctx.message.caption || "What do you see in this image?";
    const sessionId = `tg-${ctx.chat.id}`;
    const telegramMessageId = ctx.message.message_id;
    const chatId = ctx.chat.id;

    try {
      // Get the largest photo (last in the array)
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

      const res = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        await ctx.reply("Failed to download image from Telegram.");
        return;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      const base64 = buf.toString("base64");
      const ext = file.file_path?.split(".").pop()?.toLowerCase() || "jpg";
      const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";

      await traceAgentTurn("handleMessage", async () => {
        await handleMessage(ctx, caption, [{ type: "image", data: base64, mimeType }]);
      }, { sessionId, telegramMessageId, chatId });
    } catch (e: any) {
      log("error", `Failed to process photo: ${e.message}`);
      await ctx.reply(`Failed to process image: ${e.message}`);
    }
  });

  return bot;
}

/**
 * Find the best split point in text at or before maxLen.
 * Priority: double-newline (paragraph) > single newline > sentence end > word boundary > hard cut.
 */
function findSplitPoint(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;

  // 1. Paragraph boundary: double newline
  let idx = text.lastIndexOf("\n\n", maxLen);
  if (idx > maxLen / 2) return idx + 2; // include the newlines in the first chunk

  // 2. Single newline
  idx = text.lastIndexOf("\n", maxLen);
  if (idx > maxLen / 2) return idx + 1;

  // 3. Sentence boundary: ". ", "! ", "? "
  const sentenceMatch = text.slice(0, maxLen).match(/^.*[.!?]\s/s);
  if (sentenceMatch && sentenceMatch[0].length > maxLen / 2) {
    return sentenceMatch[0].length;
  }

  // 4. Word boundary: last space
  idx = text.lastIndexOf(" ", maxLen);
  if (idx > maxLen / 2) return idx + 1;

  // 5. Hard cut at maxLen
  return maxLen;
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const splitAt = findSplitPoint(remaining, maxLen);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
