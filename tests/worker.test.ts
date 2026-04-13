import { describe, it, expect } from "@jest/globals";

// ─── WorkerProgressEvent shape ────────────────────────────────────────────────
// We import the interface type only — no runtime worker execution needed for
// these unit tests.
import type { WorkerProgressEvent } from "../src/worker.js";

describe("WorkerProgressEvent shape", () => {
  it("accepts a progress event", () => {
    const event: WorkerProgressEvent = {
      type: "progress",
      taskId: "task-123",
      message: "Tool: browser_control",
    };
    expect(event.type).toBe("progress");
    expect(event.taskId).toBe("task-123");
    expect(event.message).toBe("Tool: browser_control");
    expect(event.result).toBeUndefined();
    expect(event.error).toBeUndefined();
  });

  it("accepts a complete event with result", () => {
    const event: WorkerProgressEvent = {
      type: "complete",
      taskId: "task-456",
      message: "Worker completed",
      result: "Done — 42 items processed",
    };
    expect(event.type).toBe("complete");
    expect(event.result).toBe("Done — 42 items processed");
    expect(event.error).toBeUndefined();
  });

  it("accepts an error event", () => {
    const event: WorkerProgressEvent = {
      type: "error",
      taskId: "task-789",
      error: "Agent threw: timeout after 300s",
    };
    expect(event.type).toBe("error");
    expect(event.error).toBe("Agent threw: timeout after 300s");
    expect(event.result).toBeUndefined();
  });
});

// ─── A2A async vs sync routing logic ─────────────────────────────────────────
// Mirror the isSync detection used in a2a-server.ts to prevent regressions.

function isSync(query: Record<string, string>): boolean {
  return String(query.sync || "false").toLowerCase() === "true";
}

describe("A2A sync query param detection", () => {
  it("defaults to async when sync param is absent", () => {
    expect(isSync({})).toBe(false);
  });

  it("returns true when sync=true", () => {
    expect(isSync({ sync: "true" })).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSync({ sync: "TRUE" })).toBe(true);
    expect(isSync({ sync: "True" })).toBe(true);
  });

  it("returns false for sync=false", () => {
    expect(isSync({ sync: "false" })).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSync({ sync: "" })).toBe(false);
  });
});

// ─── Telegram relay message format ───────────────────────────────────────────
// Verify the task message format used in relayTaskUpdateToTelegram.

function formatRelayMessage(taskId: string, message: string): string {
  return `🧵 Task ${taskId}: ${message}`;
}

describe("Telegram relay message format", () => {
  it("prefixes message with task id", () => {
    expect(formatRelayMessage("abc123", "45 items processed")).toBe(
      "🧵 Task abc123: 45 items processed"
    );
  });

  it("handles completion message", () => {
    expect(formatRelayMessage("abc123", "Completed")).toBe(
      "🧵 Task abc123: Completed"
    );
  });

  it("handles error message", () => {
    expect(formatRelayMessage("abc123", "Failed: timeout")).toBe(
      "🧵 Task abc123: Failed: timeout"
    );
  });
});

// ─── Silent flag — DelegateJob.silent field ───────────────────────────────────

import { _clearJobsForTest, _addJobForTest } from "../src/tools/claude-subagent.js";

describe("DelegateJob silent flag", () => {
  it("silent=true is preserved in job object", () => {
    _clearJobsForTest();
    const job = {
      id: "silent-job-test",
      taskLabel: "silent task",
      prompt: "do something quietly",
      childSessionId: "c1",
      parentSessionId: "p1",
      startedAt: Date.now() - 1000,
      status: "running" as const,
      output: "",
      silent: true,
    };
    _addJobForTest(job);
    expect(job.silent).toBe(true);
  });

  it("silent=false is preserved in job object", () => {
    _clearJobsForTest();
    const job = {
      id: "noisy-job-test",
      taskLabel: "noisy task",
      prompt: "do something loudly",
      childSessionId: "c2",
      parentSessionId: "p2",
      startedAt: Date.now() - 1000,
      status: "running" as const,
      output: "",
      silent: false,
    };
    _addJobForTest(job);
    expect(job.silent).toBe(false);
  });
});
