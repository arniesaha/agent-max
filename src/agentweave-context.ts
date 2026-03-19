/**
 * Shared AgentWeave session context.
 * Updated by a2a-server.ts when processing A2A tasks.
 * Read by nix-relay.ts when invoking delegate_to_nix.
 */
let _currentSession = "max-main";

export function setAgentWeaveSession(sessionId: string): void {
  _currentSession = sessionId;
}

export function getAgentWeaveSession(): string {
  return _currentSession;
}

export function resetAgentWeaveSession(): void {
  _currentSession = "max-main";
}
