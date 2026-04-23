import { describe, it, expect } from "@jest/globals";
import { pruneStaleToolResults } from "../src/context.js";

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
