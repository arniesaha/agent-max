/**
 * Telegram notification helpers.
 * Extracted here to avoid circular imports between a2a-server.ts and claude-subagent.ts.
 */

/**
 * Format a duration in milliseconds to a human-readable string.
 * < 60s  → "42s"
 * < 1h   → "1m 42s"
 * >= 1h  → "2h 5m"
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Truncate a result string to maxChars, appending "…" if truncated.
 */
export function summarizeResult(text: string, maxChars = 200): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}

/**
 * Send a raw task update message to all configured Telegram chat IDs.
 * Used for mid-task progress messages (🧵 prefix).
 */
export async function relayTaskUpdateToTelegram(taskId: string, message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = (process.env.TELEGRAM_ALLOWED_USERS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (!token || chatIds.length === 0) return;

  await Promise.all(
    chatIds.map(async (chatId) => {
      try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `🧵 Task ${taskId}: ${message}`,
            disable_notification: true,
          }),
        });
      } catch {
        // best effort
      }
    })
  );
}

export interface JobCompletionPayload {
  taskLabel: string;
  status: "completed" | "failed" | "timed_out";
  durationMs: number;
  result?: string;
  error?: string;
}

/**
 * Send a completion/failure/timeout notification to Telegram.
 * Used by receiveCallback in claude-subagent.ts and the A2A worker handler.
 */
export async function relayJobCompletionToTelegram(payload: JobCompletionPayload): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = (process.env.TELEGRAM_ALLOWED_USERS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (!token || chatIds.length === 0) return;

  const duration = formatDuration(payload.durationMs);
  let text: string;

  if (payload.status === "completed") {
    const summary = summarizeResult(payload.result?.trim() || "(no output)");
    text = `✅ Task ${payload.taskLabel}: completed in ${duration} — ${summary}`;
  } else if (payload.status === "timed_out") {
    text = `⏱️ Task ${payload.taskLabel}: timed out after ${duration}`;
  } else {
    text = `❌ Task ${payload.taskLabel}: failed in ${duration} — ${payload.error || "unknown error"}`;
  }

  await Promise.all(
    chatIds.map(async (chatId) => {
      try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_notification: false,
          }),
        });
      } catch {
        // best effort
      }
    })
  );
}
