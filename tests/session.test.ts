import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { _resetDbForTest, setState, getState } = await import("../src/task-journal.js");
const { saveSession, restoreSession, clearSession, sessionStorageKey } = await import("../src/session.js");

function agentWith(messages: any[] = []) {
  return { state: { messages } } as any;
}

let tmpPath: string;

beforeEach(() => {
  jest.useFakeTimers();
  tmpPath = join(mkdtempSync(join(tmpdir(), "agent-max-session-test-")), "journal.db");
  process.env.MAX_DB_PATH = tmpPath;
  _resetDbForTest();
});

afterEach(() => {
  jest.useRealTimers();
  _resetDbForTest();
  delete process.env.MAX_DB_PATH;
  rmSync(tmpPath.replace(/journal\.db$/, ""), { recursive: true, force: true });
});

describe("session persistence buckets", () => {
  it("saves and restores isolated Telegram and A2A buckets", async () => {
    saveSession(agentWith([{ role: "user", content: "telegram hello" }]), "telegram:direct:111");
    saveSession(agentWith([{ role: "user", content: "a2a hello" }]), "a2a:task-001");
    await jest.advanceTimersByTimeAsync(600);

    const telegramAgent = agentWith();
    const a2aAgent = agentWith();

    expect(restoreSession(telegramAgent, "telegram:direct:111")).toBe(1);
    expect(restoreSession(a2aAgent, "a2a:task-001")).toBe(1);
    expect(telegramAgent.state.messages[0].content).toBe("telegram hello");
    expect(a2aAgent.state.messages[0].content).toBe("a2a hello");
  });

  it("migrates the legacy global session_messages key to max:main", () => {
    const legacy = JSON.stringify([{ role: "user", content: "legacy main" }]);
    setState("session_messages", legacy);

    const mainAgent = agentWith();
    expect(restoreSession(mainAgent)).toBe(1);

    expect(mainAgent.state.messages[0].content).toBe("legacy main");
    expect(getState(sessionStorageKey("max:main"))).toBe(legacy);
  });

  it("clears only the requested bucket", async () => {
    saveSession(agentWith([{ role: "user", content: "chat one" }]), "telegram:direct:1");
    saveSession(agentWith([{ role: "user", content: "chat two" }]), "telegram:direct:2");
    await jest.advanceTimersByTimeAsync(600);

    clearSession("telegram:direct:1");

    const one = agentWith([{ role: "user", content: "stale" }]);
    const two = agentWith();
    expect(restoreSession(one, "telegram:direct:1")).toBe(0);
    expect(restoreSession(two, "telegram:direct:2")).toBe(1);
    expect(one.state.messages).toEqual([]);
    expect(two.state.messages[0].content).toBe("chat two");
  });
});
