import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

const state = new Map<string, string>();

jest.unstable_mockModule("../src/task-journal.js", () => ({
  getState: jest.fn((key: string) => state.get(key)),
  setState: jest.fn((key: string, value: string) => state.set(key, value)),
}));

jest.unstable_mockModule("../src/logger.js", () => ({ log: jest.fn() }));

function makeAgent(messages: any[] = []) {
  return { state: { messages } } as any;
}

function user(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

beforeEach(async () => {
  jest.useFakeTimers();
  state.clear();
});

afterEach(async () => {
  jest.useRealTimers();
  state.clear();
});

describe("session storage isolation", () => {
  it("saves and restores messages by explicit sessionKey", async () => {
    const { saveSession, restoreSession } = await import("../src/session.js");

    const telegramCtx = { sessionId: "max-telegram-1", sessionKey: "telegram:1", agentType: "main" as const };
    const a2aCtx = { sessionId: "max-a2a-task-1", sessionKey: "a2a:sync:nix:task-1", agentType: "delegated" as const };

    saveSession(makeAgent([user("telegram turn")]), telegramCtx);
    saveSession(makeAgent([user("a2a turn")]), a2aCtx);
    jest.advanceTimersByTime(600);

    const restoredTelegram = makeAgent([user("contaminated")]);
    const restoredA2A = makeAgent([user("contaminated")]);

    expect(restoreSession(restoredTelegram, telegramCtx)).toBe(1);
    expect(restoreSession(restoredA2A, a2aCtx)).toBe(1);
    expect((restoredTelegram.state.messages[0] as any).content[0].text).toBe("telegram turn");
    expect((restoredA2A.state.messages[0] as any).content[0].text).toBe("a2a turn");
  });

  it("clears in-memory messages when switching to an empty bucket", async () => {
    const { restoreSession } = await import("../src/session.js");
    const emptyCtx = { sessionId: "max-telegram-2", sessionKey: "telegram:2", agentType: "main" as const };
    const agent = makeAgent([user("previous bucket")]);

    expect(restoreSession(agent, emptyCtx)).toBe(0);
    expect(agent.state.messages).toEqual([]);
  });

  it("snapshots messages at save time so later bucket switches cannot contaminate debounced saves", async () => {
    const { saveSession, restoreSession } = await import("../src/session.js");
    const telegramCtx = { sessionId: "max-telegram-1", sessionKey: "telegram:1", agentType: "main" as const };
    const a2aCtx = { sessionId: "max-a2a-task-1", sessionKey: "a2a:sync:nix:task-1", agentType: "delegated" as const };
    const sharedAgent = makeAgent([user("telegram before timer")]);

    saveSession(sharedAgent, telegramCtx);
    sharedAgent.state.messages = [user("a2a after switch")];
    saveSession(sharedAgent, a2aCtx);
    jest.advanceTimersByTime(600);

    const restoredTelegram = makeAgent();
    const restoredA2A = makeAgent();
    restoreSession(restoredTelegram, telegramCtx);
    restoreSession(restoredA2A, a2aCtx);

    expect((restoredTelegram.state.messages[0] as any).content[0].text).toBe("telegram before timer");
    expect((restoredA2A.state.messages[0] as any).content[0].text).toBe("a2a after switch");
  });

  it("falls back to the legacy global key only for main session migration", async () => {
    const { restoreSession } = await import("../src/session.js");

    state.set("session_messages", JSON.stringify([user("legacy main")]));

    const mainAgent = makeAgent();
    const telegramAgent = makeAgent([user("previous")]);
    expect(restoreSession(mainAgent, { sessionId: "max-main", sessionKey: "main", agentType: "main" })).toBe(1);
    expect((mainAgent.state.messages[0] as any).content[0].text).toBe("legacy main");

    expect(restoreSession(telegramAgent, { sessionId: "max-telegram-3", sessionKey: "telegram:3", agentType: "main" })).toBe(0);
    expect(telegramAgent.state.messages).toEqual([]);
  });
});
