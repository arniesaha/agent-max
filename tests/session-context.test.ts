import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const { withSessionContext, getSessionContext, getAgentWeaveSession } = await import("../src/agentweave-context.js");
const { delegateToNix } = await import("../src/tools/nix-relay.js");

describe("active session context", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("uses async-local session context for AgentWeave session lookup", async () => {
    await withSessionContext({ sessionKey: "telegram:direct:42", sessionId: "telegram:direct:42", surface: "telegram" }, async () => {
      expect(getSessionContext().sessionKey).toBe("telegram:direct:42");
      expect(getAgentWeaveSession()).toBe("telegram:direct:42");
    });
  });

  it("delegate_to_nix propagates the active parent session id and key", async () => {
    const fetchMock = jest.fn(async (_url: string, opts: any) => {
      if (opts.method === "POST") {
        return { ok: true, json: async () => ({ id: "nix-task-1", status: "completed", result: { reply: "done" } }) } as any;
      }
      return { ok: true, json: async () => ({ id: "nix-task-1", status: "completed", result: { reply: "done" } }) } as any;
    });
    const originalFetch = global.fetch;
    (global as any).fetch = fetchMock;
    try {
      await withSessionContext({ sessionKey: "telegram:direct:42", sessionId: "telegram:direct:42", surface: "telegram" }, async () => {
        const result = await delegateToNix.execute("tool-1", { task: "look this up", skill_id: "recall_search" } as any);
        expect(result.details?.success).toBe(true);
      });
    } finally {
      (global as any).fetch = originalFetch;
    }

    const postHeaders = fetchMock.mock.calls[0][1].headers;
    expect(postHeaders["X-AgentWeave-Parent-Session-Id"]).toBe("telegram:direct:42");
    expect(postHeaders["X-AgentWeave-Parent-Session-Key"]).toBe("telegram:direct:42");
    expect(postHeaders["X-AgentWeave-Delegated-Session-Id"]).toMatch(/^nix-a2a-/);
  });
});
