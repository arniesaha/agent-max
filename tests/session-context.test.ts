import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { webcrypto } from "crypto";

jest.unstable_mockModule("../src/logger.js", () => ({ log: jest.fn() }));

const { withSessionContext, getAgentWeaveSession, getAgentWeaveSessionKey } = await import("../src/agentweave-context.js");
const { delegateToNix } = await import("../src/tools/nix-relay.js");

beforeEach(() => {
  delete process.env.A2A_SHARED_SECRET;
  (globalThis as any).crypto = webcrypto;
});

describe("active session context", () => {
  it("keeps concurrent async session ids isolated", async () => {
    const [a, b] = await Promise.all([
      withSessionContext({ sessionId: "session-a", sessionKey: "bucket-a", agentType: "main" }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return [getAgentWeaveSession(), getAgentWeaveSessionKey()];
      }),
      withSessionContext({ sessionId: "session-b", sessionKey: "bucket-b", agentType: "delegated" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return [getAgentWeaveSession(), getAgentWeaveSessionKey()];
      }),
    ]);

    expect(a).toEqual(["session-a", "bucket-a"]);
    expect(b).toEqual(["session-b", "bucket-b"]);
    expect(getAgentWeaveSession()).toBe("max-main");
  });

  it("delegate_to_nix propagates active session id and key headers", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "nix-task-1", status: "completed", result: { reply: "done" } }),
    } as any);
    const previousFetch = global.fetch;
    global.fetch = fetchMock;

    try {
      await withSessionContext(
        { sessionId: "max-telegram-42", sessionKey: "telegram:42", agentType: "main" },
        () => delegateToNix.execute("tool-1", { task: "hello", skill_id: "general" } as any)
      );

      const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["X-AgentWeave-Parent-Session-Id"]).toBe("max-telegram-42");
      expect(headers["X-AgentWeave-Parent-Session-Key"]).toBe("telegram:42");
      expect(headers["X-AgentWeave-Delegated-Session-Id"]).toMatch(/^nix-a2a-/);
      expect(headers["X-AgentWeave-Delegated-Session-Key"]).toMatch(/^nix:a2a:/);
    } finally {
      global.fetch = previousFetch;
    }
  });
});
