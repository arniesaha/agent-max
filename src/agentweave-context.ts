import { AsyncLocalStorage } from "async_hooks";

export interface SessionContext {
  /** AgentWeave/Langfuse session id used for trace attribution. */
  sessionId: string;
  /** Stable Max-owned bucket id used for persisted Pi messages. */
  sessionKey: string;
  /** AgentWeave agent type for this turn. */
  agentType: "main" | "delegated" | "worker" | "subagent";
  /** Optional parent session id when this session is delegated by another agent. */
  parentSessionId?: string;
  /** Optional parent session storage key supplied by the caller. */
  parentSessionKey?: string;
  /** Human-readable task label for traces/session graph rows. */
  taskLabel?: string;
}

export const MAIN_SESSION_CONTEXT: SessionContext = {
  sessionId: "max-main",
  sessionKey: "main",
  agentType: "main",
};

const storage = new AsyncLocalStorage<SessionContext>();

function cleanPart(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "unknown";
}

export function normalizeSessionContext(ctx?: Partial<SessionContext> | null): SessionContext {
  const sessionId = cleanPart(ctx?.sessionId || MAIN_SESSION_CONTEXT.sessionId);
  const sessionKey = cleanPart(ctx?.sessionKey || sessionId);
  return {
    sessionId,
    sessionKey,
    agentType: ctx?.agentType || MAIN_SESSION_CONTEXT.agentType,
    parentSessionId: ctx?.parentSessionId ? cleanPart(ctx.parentSessionId) : undefined,
    parentSessionKey: ctx?.parentSessionKey ? cleanPart(ctx.parentSessionKey) : undefined,
    taskLabel: ctx?.taskLabel,
  };
}

export function getSessionContext(): SessionContext {
  return storage.getStore() ?? MAIN_SESSION_CONTEXT;
}

export function withSessionContext<T>(ctx: Partial<SessionContext>, fn: () => T): T {
  return storage.run(normalizeSessionContext(ctx), fn);
}

export function makeTelegramSessionContext(chatId: string | number): SessionContext {
  const chat = cleanPart(String(chatId));
  return {
    sessionId: `max-telegram-${chat}`,
    sessionKey: `telegram:${chat}`,
    agentType: "main",
  };
}

export function makeA2ASessionContext(args: {
  taskId: string;
  sync: boolean;
  parentSessionId?: string;
  delegatedSessionId?: string;
  delegatedSessionKey?: string;
  callerAgentId?: string;
  taskLabel?: string;
  parentSessionKey?: string;
}): SessionContext {
  const caller = cleanPart(args.callerAgentId || "unknown");
  const mode = args.sync ? "sync" : "worker";
  const sessionId = args.delegatedSessionId || `max-a2a-${args.taskId}`;
  return {
    sessionId,
    sessionKey: args.delegatedSessionKey ? cleanPart(args.delegatedSessionKey) : `a2a:${mode}:${caller}:${args.taskId}`,
    agentType: args.sync ? "delegated" : "worker",
    parentSessionId: args.parentSessionId,
    parentSessionKey: args.parentSessionKey,
    taskLabel: args.taskLabel,
  };
}

export function makeTuiSessionContext(): SessionContext {
  return {
    sessionId: "max-tui",
    sessionKey: "tui",
    agentType: "main",
  };
}

export function getAgentWeaveSession(): string {
  return getSessionContext().sessionId;
}

export function getAgentWeaveSessionKey(): string {
  return getSessionContext().sessionKey;
}

// Backwards-compatible shims for older tests/imports. New runtime code should
// use withSessionContext() so async work cannot inherit stale process globals.
export function setAgentWeaveSession(_sessionId: string): void {}
export function resetAgentWeaveSession(): void {}
