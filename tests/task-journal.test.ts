import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

let tmpRoot: string;

beforeEach(async () => {
  // Fresh DB per test, isolated from the prod ~/max/data/task-journal.db
  tmpRoot = mkdtempSync(path.join(tmpdir(), "max-journal-"));
  process.env.MAX_DB_PATH = path.join(tmpRoot, "journal.db");
  // Force module to re-read env on next getDb()
  const journal = await import("../src/task-journal.js");
  journal._resetDbForTest();
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("task-journal activity watermarking", () => {
  it("appendActivity assigns monotonically increasing seqs per task starting at 1", async () => {
    const { createTask, appendActivity, getActivity } = await import("../src/task-journal.js");
    const task = createTask("a2a_task", "nix", { text: "hi" });

    expect(appendActivity(task.id, "first").seq).toBe(1);
    expect(appendActivity(task.id, "second").seq).toBe(2);
    expect(appendActivity(task.id, "third").seq).toBe(3);

    const log = getActivity(task.id);
    expect(log.map((e) => e.message)).toEqual(["first", "second", "third"]);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("seqs are independent across tasks", async () => {
    const { createTask, appendActivity } = await import("../src/task-journal.js");
    const a = createTask("a2a_task", "nix", { text: "a" });
    const b = createTask("a2a_task", "nix", { text: "b" });

    expect(appendActivity(a.id, "a1").seq).toBe(1);
    expect(appendActivity(b.id, "b1").seq).toBe(1);
    expect(appendActivity(a.id, "a2").seq).toBe(2);
    expect(appendActivity(b.id, "b2").seq).toBe(2);
  });

  it("getUnreportedActivity returns only entries with seq > last_reported_seq", async () => {
    const { createTask, appendActivity, getUnreportedActivity, advanceReportedSeq } = await import(
      "../src/task-journal.js"
    );
    const task = createTask("a2a_task", "nix", { text: "x" });

    appendActivity(task.id, "one");
    appendActivity(task.id, "two");
    appendActivity(task.id, "three");

    expect(getUnreportedActivity(task.id).map((e) => e.seq)).toEqual([1, 2, 3]);

    advanceReportedSeq(task.id, 2);
    expect(getUnreportedActivity(task.id).map((e) => e.message)).toEqual(["three"]);

    advanceReportedSeq(task.id, 3);
    expect(getUnreportedActivity(task.id)).toEqual([]);
  });

  it("advanceReportedSeq never moves backward", async () => {
    const { createTask, appendActivity, getUnreportedActivity, advanceReportedSeq } = await import(
      "../src/task-journal.js"
    );
    const task = createTask("a2a_task", "nix", { text: "x" });
    appendActivity(task.id, "one");
    appendActivity(task.id, "two");

    advanceReportedSeq(task.id, 2);
    advanceReportedSeq(task.id, 1); // attempt to rewind — must be ignored

    expect(getUnreportedActivity(task.id)).toEqual([]);
  });

  it("appendActivity + drain pattern is idempotent against replay", async () => {
    const { createTask, appendActivity, getUnreportedActivity, advanceReportedSeq } = await import(
      "../src/task-journal.js"
    );
    const task = createTask("a2a_task", "nix", { text: "x" });

    appendActivity(task.id, "step 1");
    let pending = getUnreportedActivity(task.id);
    expect(pending.length).toBe(1);
    advanceReportedSeq(task.id, pending[pending.length - 1].seq);

    // Second drain with no new activity yields nothing — no duplicate report.
    expect(getUnreportedActivity(task.id)).toEqual([]);

    appendActivity(task.id, "step 2");
    pending = getUnreportedActivity(task.id);
    expect(pending.map((e) => e.message)).toEqual(["step 2"]);
    advanceReportedSeq(task.id, pending[pending.length - 1].seq);

    expect(getUnreportedActivity(task.id)).toEqual([]);
  });

  it("getUnreportedActivity returns [] for unknown task", async () => {
    const { getUnreportedActivity } = await import("../src/task-journal.js");
    expect(getUnreportedActivity("does-not-exist")).toEqual([]);
  });

  it("new task records have last_reported_seq = 0", async () => {
    const { createTask, getDb } = await import("../src/task-journal.js");
    const task = createTask("a2a_task", "nix", { text: "x" });
    const row = getDb()
      .prepare(`SELECT last_reported_seq FROM tasks WHERE id = ?`)
      .get(task.id) as { last_reported_seq: number };
    expect(row.last_reported_seq).toBe(0);
  });
});
