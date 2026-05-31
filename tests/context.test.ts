import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { includeActiveBrief, pruneStaleToolResults, transformContext, getContextStats } from "../src/context.js";
import { _resetDbForTest } from "../src/task-journal.js";
import { getSessionBrief, setSessionBrief } from "../src/session.js";

let tmpRoot: string | null = null;

beforeEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = mkdtempSync(path.join(tmpdir(), "max-context-"));
  process.env.MAX_DB_PATH = path.join(tmpRoot, "journal.db");
  _resetDbForTest();
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function mkUser(text: string): any {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function mkAssistantToolCall(name: string, id: string): any {
  return {
    role: "assistant",
    content: [{ type: "toolCall", name, toolCallId: id, input: {} }],
    timestamp: Date.now(),
  };
}
function mkToolResult(name: string, id: string, body: string, isError = false): any {
  return {
    role: "toolResult",
    toolName: name,
    toolCallId: id,
    isError,
    content: [{ type: "text", text: body }],
    timestamp: Date.now(),
  };
}

describe("pruneStaleToolResults", () => {
  const heavyBody = "x".repeat(5000);
  const tinyBody = "hello";

  it("no-ops when under freshTurns", () => {
    const msgs = [
      mkUser("first"),
      mkAssistantToolCall("run_shell", "t1"),
      mkToolResult("run_shell", "t1", heavyBody),
      mkUser("second"),
    ];
    const out = pruneStaleToolResults(msgs, 4);
    expect(out).toBe(msgs); // same reference when unchanged
  });

  it("prunes tool results older than the last N user turns", () => {
    const old = mkToolResult("run_shell", "t1", heavyBody);
    const msgs = [
      mkUser("turn1"),
      mkAssistantToolCall("run_shell", "t1"),
      old,
      mkUser("turn2"),
      mkUser("turn3"),
      mkAssistantToolCall("read_file", "t2"),
      mkToolResult("read_file", "t2", heavyBody),
      mkUser("turn4"),
      mkUser("turn5"),
    ];
    const out = pruneStaleToolResults(msgs, 2);
    // Last 2 user turns = turn4 + turn5. Everything before turn4 is stale.
    const firstTR = out.find((m: any) => m.role === "toolResult" && m.toolCallId === "t1") as any;
    const secondTR = out.find((m: any) => m.role === "toolResult" && m.toolCallId === "t2") as any;
    expect(firstTR.content[0].text).toMatch(/run_shell result — body pruned/);
    expect(secondTR.content[0].text).toMatch(/read_file result — body pruned/);
    // Structure preserved
    expect(firstTR.toolCallId).toBe("t1");
    expect(firstTR.role).toBe("toolResult");
  });

  it("keeps fresh tool results intact", () => {
    const fresh = mkToolResult("run_shell", "t1", heavyBody);
    const msgs = [
      mkUser("old"),
      mkUser("fresh"),
      mkAssistantToolCall("run_shell", "t1"),
      fresh,
    ];
    const out = pruneStaleToolResults(msgs, 2);
    const tr = out.find((m: any) => m.toolCallId === "t1") as any;
    expect(tr.content[0].text).toBe(heavyBody);
  });

  it("leaves small tool results alone even if stale", () => {
    const small = mkToolResult("gpu_status", "t1", tinyBody);
    const msgs = [
      mkUser("u1"),
      mkAssistantToolCall("gpu_status", "t1"),
      small,
      mkUser("u2"),
      mkUser("u3"),
    ];
    const out = pruneStaleToolResults(msgs, 1);
    const tr = out.find((m: any) => m.toolCallId === "t1") as any;
    expect(tr.content[0].text).toBe(tinyBody);
  });

  it("is idempotent", () => {
    const msgs = [
      mkUser("u1"),
      mkAssistantToolCall("run_shell", "t1"),
      mkToolResult("run_shell", "t1", heavyBody),
      mkUser("u2"),
      mkUser("u3"),
    ];
    const once = pruneStaleToolResults(msgs, 1);
    const twice = pruneStaleToolResults(once, 1);
    expect(twice).toBe(once); // second pass returns same reference
  });

  it("does not alter non-toolResult messages", () => {
    const msgs = [
      mkUser("u1"),
      mkAssistantToolCall("run_shell", "t1"),
      mkToolResult("run_shell", "t1", heavyBody),
      mkUser("u2"),
      mkUser("u3"),
    ];
    const out = pruneStaleToolResults(msgs, 1);
    expect(out[0]).toBe(msgs[0]);
    expect(out[1]).toBe(msgs[1]);
    expect(out[3]).toBe(msgs[3]);
    expect(out[4]).toBe(msgs[4]);
  });
});

describe("active session brief", () => {
  it("stores capped per-session briefs", () => {
    const brief = setSessionBrief({
      brief_md: "A".repeat(3000),
      last_user_req: "latest ask",
      current_objective: "continue task",
      suggested_next: ["one", "two", "three", "four"],
      files_touched: ["src/context.ts", "src/context.ts", "tests/context.test.ts"],
      open_blockers: "",
    }, "session-a");

    expect(brief.brief_md.length).toBeLessThanOrEqual(2048);
    expect(brief.suggested_next).toEqual(["one", "two", "three"]);
    expect(brief.files_touched).toEqual(["src/context.ts", "tests/context.test.ts"]);
    expect(getSessionBrief("session-a")?.brief_md).toBe(brief.brief_md);
    expect(getSessionBrief("session-b")).toBeNull();
  });

  it("appends the brief after the latest real user text", () => {
    setSessionBrief({
      brief_md: "Need to finish the context PR.",
      last_user_req: "older ask",
      current_objective: "ship the PR",
      suggested_next: ["run tests"],
      files_touched: ["src/context.ts"],
      open_blockers: "",
    }, "brief-session");

    const msgs = [mkUser("current ask")];
    const out = includeActiveBrief(msgs, "brief-session") as any[];

    expect(out).not.toBe(msgs);
    expect(out[0].content[0].text).toBe("current ask");
    expect(out[0].content[1].text).toContain("Active session brief");
    expect(out[0].content[1].text).toContain("Need to finish the context PR.");
  });

  it("excludes an empty or same-turn brief", async () => {
    const msgs = [mkUser("current ask")];
    expect(includeActiveBrief(msgs, "empty-session")).toBe(msgs);

    setSessionBrief({
      brief_md: "Current turn was already summarized.",
      last_user_req: "current ask",
      current_objective: "current ask",
      suggested_next: [],
      files_touched: [],
      open_blockers: "",
    }, "same-turn");

    expect(includeActiveBrief(msgs, "same-turn")).toBe(msgs);
    await expect(transformContext(msgs, "same-turn")).resolves.toBe(msgs);
  });
});

describe("context stats", () => {
  it("reports per-session pruning counters", async () => {
    const msgs = [
      mkUser("u1"),
      mkAssistantToolCall("run_shell", "t1"),
      mkToolResult("run_shell", "t1", "x".repeat(5000)),
      mkUser("u2"),
      mkUser("u3"),
      mkUser("u4"),
      mkUser("u5"),
    ];

    await transformContext(msgs, "stats-a");
    const statsA = getContextStats(msgs, "stats-a");
    const statsB = getContextStats(msgs, "stats-b");

    expect(statsA.sessionKey).toBe("stats-a");
    expect(statsA.pruningCount).toBe(1);
    expect(statsA.compactionCount).toBe(0);
    expect(statsB.pruningCount).toBe(0);
  });
});
