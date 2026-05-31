import { describe, it, expect } from "@jest/globals";
import { agentWeaveHeadersForSession } from "../src/agent.js";

describe("AgentWeave session headers", () => {
  it("attributes main/TUI traffic to max-main", () => {
    const headers = agentWeaveHeadersForSession(
      { sessionKey: "max:main", sessionId: "max-main", surface: "main", latestInputPreview: "hello" },
      { muxEnabled: false, proxyToken: "proxy-token" }
    );

    expect(headers["X-AgentWeave-Session-Id"]).toBe("max-main");
    expect(headers["X-AgentWeave-Agent-Type"]).toBe("main");
    expect(headers["X-AgentWeave-Input-Preview"]).toBe("hello");
    expect(headers["X-AgentWeave-Proxy-Token"]).toBe("proxy-token");
  });

  it("attributes Telegram traffic to the active chat session", () => {
    const headers = agentWeaveHeadersForSession(
      { sessionKey: "telegram:direct:42", sessionId: "telegram:direct:42", surface: "telegram" },
      { muxEnabled: true, muxApiKey: "mux-key" }
    );

    expect(headers["X-AgentWeave-Session-Id"]).toBe("telegram:direct:42");
    expect(headers["X-AgentWeave-Agent-Type"]).toBe("main");
    expect(headers.Authorization).toBe("Bearer mux-key");
    expect(headers["X-AgentWeave-Proxy-Token"]).toBeUndefined();
  });

  it("attributes delegated A2A traffic to the delegated session and parent", () => {
    const headers = agentWeaveHeadersForSession(
      {
        sessionKey: "a2a:task-001",
        sessionId: "max-from-nix-123",
        surface: "a2a",
        parentSessionId: "nix-session-abc",
        taskLabel: "sync-from-nix",
      },
      { muxEnabled: false }
    );

    expect(headers["X-AgentWeave-Session-Id"]).toBe("max-from-nix-123");
    expect(headers["X-AgentWeave-Parent-Session-Id"]).toBe("nix-session-abc");
    expect(headers["X-AgentWeave-Agent-Type"]).toBe("delegated");
    expect(headers["X-AgentWeave-Task-Label"]).toBe("sync-from-nix");
  });
});
