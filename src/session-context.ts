export type SessionSurface = "main" | "telegram" | "a2a" | "worker" | "tui" | "subagent";

export interface SessionContext {
  sessionKey: string;
  sessionId: string;
  surface: SessionSurface;
  taskId?: string;
  parentSessionId?: string;
  taskLabel?: string;
  latestInputPreview?: string;
}

export const MAIN_SESSION_KEY = "max:main";
export const MAIN_SESSION_ID = "max-main";

export const MAIN_SESSION_CONTEXT: SessionContext = {
  sessionKey: MAIN_SESSION_KEY,
  sessionId: MAIN_SESSION_ID,
  surface: "main",
};

export function previewInput(input: string, maxChars = 240): string {
  return input.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function telegramSessionContext(chatId: number | string, latestInputPreview?: string): SessionContext {
  const id = String(chatId);
  const sessionKey = `telegram:direct:${id}`;
  return {
    sessionKey,
    sessionId: sessionKey,
    surface: "telegram",
    latestInputPreview,
  };
}

export function a2aSessionContext(args: {
  taskId: string;
  delegatedSessionId?: string;
  parentSessionId?: string;
  taskLabel?: string;
  latestInputPreview?: string;
  surface?: "a2a" | "worker";
}): SessionContext {
  const sessionId = args.delegatedSessionId || `max-a2a-${args.taskId}`;
  return {
    sessionKey: `a2a:${args.taskId}`,
    sessionId,
    surface: args.surface || "a2a",
    taskId: args.taskId,
    parentSessionId: args.parentSessionId,
    taskLabel: args.taskLabel,
    latestInputPreview: args.latestInputPreview,
  };
}
