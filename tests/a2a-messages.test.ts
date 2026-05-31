import { describe, it, expect, jest } from "@jest/globals";

jest.unstable_mockModule("../src/task-journal.js", () => ({
  createTask: jest.fn().mockReturnValue({ id: "task-001", status: "working" }),
  updateTaskStatus: jest.fn(),
  getRecentTasks: jest.fn().mockReturnValue([]),
  getDb: jest.fn().mockReturnValue({
    prepare: jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue(null),
      all: jest.fn().mockReturnValue([]),
    }),
  }),
  appendActivity: jest.fn().mockReturnValue({ seq: 1 }),
  getUnreportedActivity: jest.fn().mockReturnValue([]),
  advanceReportedSeq: jest.fn(),
  setActualCost: jest.fn(),
}));
jest.unstable_mockModule("../src/logger.js", () => ({ log: jest.fn() }));
jest.unstable_mockModule("../src/session.js", () => ({
  saveSession: jest.fn(),
  restoreSession: jest.fn(),
  loadSessionMessages: jest.fn().mockReturnValue([
    { role: "user", content: [{ type: "text", text: "saved TUI request" }] },
    { role: "assistant", content: [{ type: "text", text: "saved TUI response" }] },
  ]),
}));
jest.unstable_mockModule("../src/agentweave-context.js", () => ({
  getAgentWeaveSession: jest.fn().mockReturnValue("max-main"),
  makeA2ASessionContext: jest.fn((args: any) => ({
    sessionId: args.delegatedSessionId || `max-a2a-${args.taskId}`,
    sessionKey: `a2a:${args.sync ? "sync" : "worker"}:test:${args.taskId}`,
    agentType: args.sync ? "delegated" : "worker",
  })),
  makeTuiSessionContext: jest.fn(() => ({ sessionId: "max-tui", sessionKey: "tui", agentType: "main" })),
  withSessionContext: jest.fn((_ctx: any, fn: any) => fn()),
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

const SECRET = "test-messages-secret";
process.env.A2A_SHARED_SECRET = SECRET;

const { createA2AServer } = await import("../src/a2a-server.js");
const { restoreSession, loadSessionMessages } = await import("../src/session.js");

function makeAgent(messages: any[] = []) {
  return {
    state: { isStreaming: false, messages },
    subscribe: jest.fn().mockReturnValue(() => {}),
    prompt: jest.fn(),
    abort: jest.fn(),
  } as any;
}

async function callEndpoint(
  app: ReturnType<typeof createA2AServer>,
  method: string,
  path: string,
  opts: { auth?: string } = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.auth) headers["Authorization"] = opts.auth;
      fetch(`http://127.0.0.1:${addr.port}${path}`, { method, headers })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe("GET /messages", () => {
  it("reads saved TUI messages without mutating the live Agent message context", async () => {
    const liveMessages = [
      { role: "user", content: [{ type: "text", text: "active A2A request" }] },
      { role: "assistant", content: [{ type: "text", text: "active A2A response" }] },
    ];
    const agent = makeAgent(liveMessages);
    const app = createA2AServer(agent);

    const res = await callEndpoint(app, "GET", "/messages", { auth: `Bearer ${SECRET}` });

    expect(res.status).toBe(200);
    expect(loadSessionMessages).toHaveBeenCalledWith({ sessionId: "max-tui", sessionKey: "tui", agentType: "main" });
    expect(restoreSession).not.toHaveBeenCalled();
    expect(res.body.messages).toEqual([
      { role: "user", text: "saved TUI request" },
      { role: "assistant", text: "saved TUI response" },
    ]);
    expect(agent.state.messages).toBe(liveMessages);
    expect(agent.state.messages[0].content[0].text).toBe("active A2A request");
  });
});
