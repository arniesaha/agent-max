import { describe, it, expect, jest } from "@jest/globals";

/**
 * Tests for POST /tasks/callback endpoint.
 * Tests the HTTP layer: auth gating, input validation, and routing.
 */

jest.unstable_mockModule("../src/task-journal.js", () => ({
  createTask: jest.fn().mockReturnValue({ id: "task-001", status: "working" }),
  updateTaskStatus: jest.fn(),
  getRecentTasks: jest.fn().mockReturnValue([]),
  getDb: jest.fn().mockReturnValue({
    prepare: jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue({ id: "known-job-001" }),
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
  formatDuration: jest.fn().mockReturnValue("1s"),
  summarizeResult: jest.fn().mockImplementation((t: unknown) => t as string),
}));
jest.unstable_mockModule("../src/tools/claude-subagent.js", () => ({
  receiveCallback: jest.fn(),
  delegateToClaudeSubagent: {},
  _clearJobsForTest: jest.fn(),
  _addJobForTest: jest.fn(),
  evictOldJobs: jest.fn(),
  truncateOutput: jest.fn().mockImplementation((t: unknown) => t),
  MAX_OUTPUT_CHARS: 15000,
}));
jest.unstable_mockModule("worker_threads", () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), terminate: jest.fn() })),
}));

const SECRET = "test-secret-callback";
process.env.A2A_SHARED_SECRET = SECRET;

const { createA2AServer } = await import("../src/a2a-server.js");
const { receiveCallback } = await import("../src/tools/claude-subagent.js");
const receiveCallbackMock = receiveCallback as jest.Mock;

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
  opts: { auth?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
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

describe("POST /tasks/callback — HTTP layer", () => {
  it("returns 401 without Authorization header", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks/callback", {
      body: { jobId: "known-job-001", status: "completed" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong secret", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks/callback", {
      auth: "Bearer wrong-secret",
      body: { jobId: "known-job-001", status: "completed" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing jobId", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks/callback", {
      auth: `Bearer ${SECRET}`,
      body: { status: "completed" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobId/i);
  });

  it("returns 400 for invalid status value", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks/callback", {
      auth: `Bearer ${SECRET}`,
      body: { jobId: "known-job-001", status: "bogus" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  it("accepts timed_out as a valid status", async () => {
    receiveCallbackMock.mockReturnValueOnce(true);
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks/callback", {
      auth: `Bearer ${SECRET}`,
      body: { jobId: "timed-out-job", status: "timed_out" },
    });
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
  });

  it("returns 200 with ok=true for a known job", async () => {
    receiveCallbackMock.mockReturnValueOnce(true);
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks/callback", {
      auth: `Bearer ${SECRET}`,
      body: { jobId: "known-job-001", status: "completed", result: "all done" },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.jobId).toBe("known-job-001");
  });

  it("returns 404 for unknown jobId", async () => {
    receiveCallbackMock.mockReturnValueOnce(false);
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "POST", "/tasks/callback", {
      auth: `Bearer ${SECRET}`,
      body: { jobId: "nonexistent-job-xyz", status: "failed", error: "something broke" },
    });
    expect(res.status).toBe(404);
  });
});

describe("Agent card capabilities", () => {
  it("advertises callback_endpoint=true", async () => {
    const app = createA2AServer(makeAgent());
    const res = await callEndpoint(app, "GET", "/.well-known/agent.json");
    expect(res.status).toBe(200);
    expect(res.body.capabilities?.callback_endpoint).toBe(true);
  });
});
