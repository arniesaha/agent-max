import { describe, it, expect } from "@jest/globals";
import os from "os";
import path from "path";
import { mkdtempSync } from "fs";
import { buildRequestContext, pruneStaleToolResults, transformContext } from "../src/context.js";
import { withSessionContext } from "../src/agentweave-context.js";
import { _resetDbForTest } from "../src/task-journal.js";
import { getActiveBrief, getSessionSummary, setActiveBrief, setSessionSummary } from "../src/session.js";

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


describe("session summaries and active briefs", () => {
  beforeEach(() => {
    _resetDbForTest();
    process.env.MAX_DB_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), "agent-max-context-")), "state.db");
  });

  afterEach(() => {
    _resetDbForTest();
    delete process.env.MAX_DB_PATH;
  });

  it("stores active briefs per session and caps large fields", () => {
    setActiveBrief("coding-session", {
      brief_md: "b".repeat(3000),
      last_user_req: "r".repeat(900),
      current_objective: "ship context briefs",
      suggested_next: ["one", "two", "three", "four"],
      files_touched: Array.from({ length: 12 }, (_, i) => `src/file-${i}.ts`),
      open_blockers: "none",
      updated_at: 123,
    });

    const brief = getActiveBrief("coding-session")!;
    expect(brief.brief_md.length).toBeLessThanOrEqual(2048);
    expect(brief.last_user_req!.length).toBeLessThanOrEqual(512);
    expect(brief.suggested_next).toEqual(["one", "two", "three"]);
    expect(brief.files_touched!.length).toBe(8);
    expect(getActiveBrief("other-session")).toBeUndefined();
  });

  it("includes active brief only for opted-in work", async () => {
    setActiveBrief("coding-session", {
      brief_md: "Resume the deploy validation.",
      current_objective: "finish PR",
      updated_at: Date.now(),
    });
    const msgs = [mkUser("latest ask")];

    const casual = await buildRequestContext(msgs, { sessionKey: "coding-session", reason: "casual" });
    expect(casual.messages).toHaveLength(1);
    expect((casual.messages[0] as any).content[0].text).toBe("latest ask");

    const manual = await buildRequestContext(msgs, { sessionKey: "coding-session", reason: "manual" });
    expect((manual.messages[0] as any).content).toMatch(/ACTIVE SESSION BRIEF/);
    expect((manual.messages.at(-1) as any).content[0].text).toBe("latest ask");
  });

  it("persists a per-session summary when compaction runs", async () => {
    const heavy = "history ".repeat(12000);
    const msgs: any[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(mkUser(`old request ${i} ${heavy}`));
      msgs.push(mkAssistantToolCall("run_shell", `tool-${i}`));
      msgs.push(mkToolResult("run_shell", `tool-${i}`, heavy));
    }
    msgs.push(mkUser("current user request"));

    const result = await buildRequestContext(msgs, {
      sessionKey: "coding-session",
      disableLlmSummary: true,
    });

    expect(result.compacted).toBe(true);
    expect(result.stats.sessionKey).toBe("coding-session");
    expect(getSessionSummary("coding-session")).toContain("old request");
    expect((result.messages[0] as any).content).toMatch(/CONTEXT SUMMARY/);
    expect((result.messages.at(-1) as any).content[0].text).toBe("current user request");
  });

  it("uses the active session key in the agent transform hook", async () => {
    setSessionSummary("telegram:direct:42", "Earlier isolated Telegram context.");
    setActiveBrief("telegram:direct:42", {
      brief_md: "Only this chat should see this brief.",
      current_objective: "continue isolated context",
      updated_at: Date.now(),
    });

    const messages = [mkUser("latest ask")];
    const out = await withSessionContext(
      { sessionKey: "telegram:direct:42", sessionId: "telegram:direct:42", surface: "telegram" },
      () => transformContext(messages)
    );

    expect((out[0] as any).content).toMatch(/Earlier isolated Telegram context/);
    expect((out.at(-1) as any).content[0].text).toBe("latest ask");

    const manual = await buildRequestContext(messages, {
      sessionKey: "telegram:direct:42",
      reason: "manual",
    });
    expect(manual.messages.map((msg: any) => msg.content).join("\n")).toMatch(/Only this chat should see this brief/);
  });
});
