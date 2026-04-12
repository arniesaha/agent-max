import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Extract assistant text from messages produced during the current prompt only.
 *
 * This prevents reusing a stale assistant reply from earlier turns when a prompt
 * yields no streamed text deltas and no new assistant text message.
 */
export function extractAssistantTextFromTurn(messages: AgentMessage[], startIndex: number): string {
  const newMessages = messages.slice(Math.max(0, startIndex));

  for (let i = newMessages.length - 1; i >= 0; i--) {
    const msg: any = newMessages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const text = msg.content
      .filter((c: any): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("")
      .trim();

    if (text.length > 0) return text;
  }

  return "";
}
