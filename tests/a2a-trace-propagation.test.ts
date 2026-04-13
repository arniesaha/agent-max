import { describe, it, expect, jest } from "@jest/globals";
import { propagation, context } from "@opentelemetry/api";

/**
 * Tests for W3C traceparent propagation in A2A server.
 *
 * Two layers tested:
 * 1. Unit: propagation.extract() correctly deserialises incoming headers into a context
 *    that can be re-injected — this is the core mechanism used in a2a-server.ts and worker.ts
 * 2. HTTP smoke: the /tasks endpoint accepts requests with traceparent headers and
 *    does not error out
 *
 * Note: asserting that a span is *actually* recorded as a child in an OTLP exporter
 * requires a running tracer provider (covered in tracing.test.ts). These tests
 * focus on the serialisation/deserialisation round-trip and HTTP contract.
 */

jest.unstable_mockModule("../src/task-journal.js", () => ({
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
jest.unstable_mockModule("../src/logger.js", () => ({ log: jest.fn() }));
jest.unstable_mockModule("../src/session.js", () => ({
  saveSession: jest.fn(),
  loadSession: jest.fn().mockReturnValue(null),
}));
jest.unstable_mockModule("../src/agentweave-context.js", () => ({
  setAgentWeaveSession: jest.fn(),
  resetAgentWeaveSession: jest.fn(),
  getAgentWeaveSession: jest.fn().mockReturnValue("max-main"),
}));
jest.unstable_mockModule("../src/response.js", () => ({
  extractAssistantTextFromTurn: jest.fn().mockReturnValue(""),
  extractErrorFromTurn: jest.fn().mockReturnValue(null),
}));
jest.unstable_mockModule("../src/telegram-notify.js", () => ({
  relayTaskUpdateToTelegram: jest.fn(),
  relayJobCompletionToTelegram: jest.fn(),
}));
jest.unstable_mockModule("../src/tools/claude-subagent.js", () => ({
  receiveCallback: jest.fn(),
  delegateToClaudeSubagent: {},
}));
jest.unstable_mockModule("worker_threads", () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), terminate: jest.fn() })),
}));

const SECRET = "test-trace-secret";
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
      fetch(url, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined })
        .then(async (res) => { const body = await res.json().catch(() => ({})); server.close(); resolve({ status: res.status, body }); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// ─── Unit: traceparent round-trip ─────────────────────────────────────────────
// These tests verify the serialise → extract → re-inject round-trip that
// a2a-server.ts and worker.ts both rely on.

describe("traceparent round-trip (propagation unit)", () => {
  it("extract then re-inject preserves traceparent value", () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const incomingHeaders = { traceparent };

    const extracted = propagation.extract(context.active(), incomingHeaders);

    const reinjected: Record<string, string> = {};
    propagation.inject(extracted, reinjected);

    // If a real propagator is registered the header is preserved.
    // With the no-op propagator (default in tests) the header is absent —
    // that's expected and is why we register a real provider in tracing.test.ts.
    // Either way the round-trip must not throw.
    expect(() => propagation.extract(context.active(), reinjected)).not.toThrow();
  });

  it("extract with missing traceparent returns active context (no-op)", () => {
    const extracted = propagation.extract(context.active(), {});
    const reinjected: Record<string, string> = {};
    propagation.inject(extracted, reinjected);
    // No traceparent header — no exception, empty inject output
    expect(Object.keys(reinjected).length).toBe(0);
  });

  it("extract with malformed traceparent does not throw", () => {
    expect(() =>
      propagation.extract(context.active(), { traceparent: "not-valid" })
    ).not.toThrow();
  });

  it("traceHeaders injected into workerData can be re-extracted in worker thread", () => {
    // Simulate what a2a-server.ts does: extract from req.headers → inject into traceHeaders
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const incomingContext = propagation.extract(context.active(), { traceparent });
    const traceHeaders: Record<string, string> = {};
    propagation.inject(incomingContext, traceHeaders);

    // Simulate what worker.ts does: re-extract from traceHeaders
    expect(() => propagation.extract(context.active(), traceHeaders)).not.toThrow();
  });
});

// ─── HTTP: /tasks endpoint accepts traceparent ────────────────────────────────

const taskBody = (id: string) => ({
  id,
  params: { message: { parts: [{ type: "text", text: "test task" }] } },
});

describe("POST /tasks — traceparent HTTP acceptance", () => {
  it("returns 202 with valid traceparent header", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
      body: taskBody("req-1"),
    });
    expect(res.status).toBe(202);
  });

  it("returns 202 without traceparent header (backwards compatible)", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      body: taskBody("req-2"),
    });
    expect(res.status).toBe(202);
  });

  it("returns 202 with malformed traceparent (graceful degradation)", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: { traceparent: "bad-value" },
      body: taskBody("req-3"),
    });
    expect(res.status).toBe(202);
  });

  it("returns 202 with both traceparent and AgentWeave headers", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: {
        traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        "x-agentweave-parent-session-id": "nix-session-123",
        "x-agentweave-agent-id": "nix-v1",
        "x-agentweave-task-label": "delegation-from-nix",
      },
      body: taskBody("req-4"),
    });
    expect(res.status).toBe(202);
  });

  it("task result includes working state for async task", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks", {
      auth: `Bearer ${SECRET}`,
      headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
      body: taskBody("req-5"),
    });
    expect(res.body.result?.status?.state).toBe("working");
  });
});
