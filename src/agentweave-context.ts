import { AsyncLocalStorage } from "async_hooks";
import { MAIN_SESSION_CONTEXT, type SessionContext } from "./session-context.js";

const sessionStorage = new AsyncLocalStorage<SessionContext>();
let fallbackSessionContext: SessionContext = MAIN_SESSION_CONTEXT;

export function withSessionContext<T>(sessionContext: SessionContext, fn: () => T): T {
  return sessionStorage.run(sessionContext, fn);
}

export function getSessionContext(): SessionContext {
  return sessionStorage.getStore() || fallbackSessionContext;
}

export function setFallbackSessionContext(sessionContext: SessionContext): void {
  fallbackSessionContext = sessionContext;
}

export function setAgentWeaveSession(sessionId: string): void {
  fallbackSessionContext = { ...fallbackSessionContext, sessionId };
}

export function getAgentWeaveSession(): string {
  return getSessionContext().sessionId;
}

export function resetAgentWeaveSession(): void {
  fallbackSessionContext = MAIN_SESSION_CONTEXT;
}
