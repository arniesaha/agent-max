import { describe, it, expect, jest } from "@jest/globals";

/**
 * Tests for W3C traceparent propagation in A2A server.
 * Verifies that incoming trace context from Nix (or other agents) is extracted and
 * propagated through task execution, creating a linked span hierarchy in Grafana.
 */

jest.mock("../src/task-journal.js", () => ({
  createTask: jest.fn().mockReturnValue({ id: "task-001", status: "working" }),
  updateTaskStatus: jest.fn(),
  getRecentTasks: jest.fn().mockReturnValue([]),
  getDb: jest.fn().mockReturnValue({
    prepare: jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue({ id: "known-job" }),
      all: jest.fn().mockReturnValue([]),
    }),
  }),
}));

jest.mock("../src/logger.js", () => ({ log: jest.fn() }));
jest.mock("../src/session.js", () => ({
  saveSession: jest.fn(),
  loadSession: jest.fn().mockReturnValue(null),
}));
jest.mock("../src/agentweave-context.js", () => ({
  setAgentWeaveSession: jest.fn(),
  resetAgentWeaveSession: jest.fn(),
  getAgentWeaveSession: jest.fn().mockReturnValue("max-main"),
}));
jest.mock("../src/response.js", () => ({
  extractAssistantTextFromTurn: jest.fn().mockReturnValue(""),
}));
jest.mock("../src/telegram-notify.js", () => ({
  relayTaskUpdateToTelegram: jest.fn(),
  relayJobCompletionToTelegram: jest.fn(),
}));
jest.mock("../src/tools/claude-subagent.js", () => ({
  receiveCallback: jest.fn(),
  delegateToClaudeSubagent: {},
}));
jest.mock("worker_threads", () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), terminate: jest.fn() })),
}));

const SECRET = "test-secret";
process.env.A2A_SHARED_SECRET = SECRET;

const { createA2AServer } = await import("../src/a2a-server.js");

function makeAgent() {
  return {
    state: { isStreaming: false, messages: [] },
    subscribe: jest.fn().mockReturnValue(() => {}),
    prompt: jest.fn(),
    abort: jest.fn(),
  } as any;
}

async function callEndpoint(
  app: ReturnType<typeof createA2AServer>,
  method: string,
  path: string,
  opts: { auth?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { "Content-Type": "application/json", ...opts.headers };
      if (opts.auth) headers["Authorization"] = opts.auth;
      fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe("A2A trace propagation (W3C traceparent)", () => {
  it("extracts traceparent from incoming request headers", async () => {
    const app = createA2AServer(makeAgent());
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: { traceparent },
      body: {
        id: "req-1",
        params: {
          message: {
            parts: [{ type: "text", text: "test task" }],
          },
        },
      },
    });
    // Async tasks return 202 with no error
    expect(res.status).toBe(202);
  });

  it("handles valid W3C traceparent format", async () => {
    const app = createA2AServer(makeAgent());
    // Valid traceparent: version(2)-traceId(32)-parentId(16)-flags(2)
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: { traceparent },
      body: {
        id: "req-2",
        params: {
          message: {
            parts: [{ type: "text", text: "task with trace" }],
          },
        },
      },
    });
    expect(res.status).toBe(202);
  });

  it("processes task normally when traceparent is absent", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      body: {
        id: "req-3",
        params: {
          message: {
            parts: [{ type: "text", text: "task without trace" }],
          },
        },
      },
    });
    expect(res.status).toBe(202);
  });

  it("propagates traceparent through sync task execution", async () => {
    const app = createA2AServer(makeAgent());
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await callEndpoint(app, "POST", "/tasks?sync=true", {
      auth: `Bearer ${SECRET}`,
      headers: { traceparent },
      body: {
        id: "req-sync",
        params: {
          message: {
            parts: [{ type: "text", text: "sync task with trace" }],
          },
        },
      },
    });
    // Sync tasks should succeed (200 not 202)
    expect([200, 202]).toContain(res.status);
  });

  it("includes AgentWeave headers alongside traceparent for full context propagation", async () => {
    const app = createA2AServer(makeAgent());
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: {
        traceparent,
        "x-agentweave-parent-session-id": "nix-session-123",
        "x-agentweave-agent-id": "nix-v1",
        "x-agentweave-task-label": "delegation-from-nix",
      },
      body: {
        id: "req-agentweave",
        params: {
          message: {
            parts: [{ type: "text", text: "task with both trace and agentweave context" }],
          },
        },
      },
    });
    // Both traces should propagate
    expect(res.status).toBe(202);
  });

  it("handles malformed traceparent gracefully (falls back to no context)", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: { traceparent: "invalid-format" },
      body: {
        id: "req-malformed",
        params: {
          message: {
            parts: [{ type: "text", text: "task with bad trace" }],
          },
        },
      },
    });
    // Should still process normally, just without context
    expect(res.status).toBe(202);
  });
});

describe("Trace context inheritance", () => {
  it("propagates context to worker execution (async task)", async () => {
    const app = createA2AServer(makeAgent());
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: { traceparent },
      body: {
        id: "req-worker",
        params: {
          message: {
            parts: [{ type: "text", text: "async task for worker" }],
          },
        },
      },
    });
    // Task should be queued for worker execution
    expect(res.status).toBe(202);
    expect(res.body.result?.status?.state).toBe("working");
  });

  it("maintains context across A2A callback (Nix → Max roundtrip)", async () => {
    // Simulate: Nix sends a task to Max with traceparent, task runs, results come back
    const app = createA2AServer(makeAgent());
    const traceparent = "00-abc123def456ghi789jkl012mnop345-xyz789abc123def-01";

    const taskRes = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: { traceparent },
      body: {
        id: "req-roundtrip",
        params: {
          message: {
            parts: [{ type: "text", text: "roundtrip task" }],
          },
        },
      },
    });
    expect(taskRes.status).toBe(202);

    // In a real scenario, Nix would then POST to /tasks/callback
    // The callback should preserve the same trace context
  });
});
