import Database from "better-sqlite3";
import path from "path";
import { randomUUID } from "crypto";

function dbPath(): string {
  return process.env.MAX_DB_PATH || path.join(process.env.HOME!, "max", "data", "task-journal.db");
}

export type TaskType = "a2a_task" | "a2a_stream" | "telegram_msg" | "tool_call";
export type TaskSource = "nix" | "telegram" | "tui" | "self";
export type TaskStatus = "submitted" | "working" | "completed" | "failed";

export interface TaskRecord {
  id: string;
  type: TaskType;
  source: TaskSource;
  payload: string;
  status: TaskStatus;
  result: string | null;
  created_at: number;
  updated_at: number;
  retry_count: number;
  last_reported_seq: number;
}

export interface TaskActivity {
  task_id: string;
  seq: number;
  message: string;
  created_at: number;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(dbPath());
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id                TEXT PRIMARY KEY,
        type              TEXT NOT NULL,
        source            TEXT NOT NULL,
        payload           TEXT NOT NULL,
        status            TEXT NOT NULL,
        result            TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        retry_count       INTEGER NOT NULL DEFAULT 0,
        last_reported_seq INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS task_activity (
        task_id    TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        message    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_task_activity_task_seq
        ON task_activity (task_id, seq);

      CREATE TABLE IF NOT EXISTS agent_state (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);

    // Backfill: existing prod DBs predate last_reported_seq.
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "last_reported_seq")) {
      db.exec(`ALTER TABLE tasks ADD COLUMN last_reported_seq INTEGER NOT NULL DEFAULT 0`);
    }
  }
  return db;
}

/**
 * Test-only: close and clear the cached connection so a new dbPath() can take effect.
 * Set process.env.MAX_DB_PATH (e.g. ":memory:" or a tmp file) before re-opening.
 */
export function _resetDbForTest(): void {
  try {
    db?.close();
  } catch {
    // ignore
  }
  db = null;
}

export function createTask(type: TaskType, source: TaskSource, payload: unknown): TaskRecord {
  const now = Date.now();
  const task: TaskRecord = {
    id: randomUUID(),
    type,
    source,
    payload: JSON.stringify(payload),
    status: "submitted",
    result: null,
    created_at: now,
    updated_at: now,
    retry_count: 0,
    last_reported_seq: 0,
  };

  getDb()
    .prepare(
      `INSERT INTO tasks (id, type, source, payload, status, result, created_at, updated_at, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(task.id, task.type, task.source, task.payload, task.status, task.result, task.created_at, task.updated_at, task.retry_count);

  return task;
}

export function updateTaskStatus(id: string, status: TaskStatus, result?: unknown): void {
  getDb()
    .prepare(`UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?`)
    .run(status, result ? JSON.stringify(result) : null, Date.now(), id);
}

export function getIncompleteTasks(): TaskRecord[] {
  return getDb().prepare(`SELECT * FROM tasks WHERE status IN ('submitted', 'working') ORDER BY created_at`).all() as TaskRecord[];
}

export function getRecentTasks(limit = 10): TaskRecord[] {
  return getDb().prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`).all(limit) as TaskRecord[];
}

export function getState(key: string): string | undefined {
  const row = getDb().prepare(`SELECT value FROM agent_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(key: string, value: string): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO agent_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(key, value, Date.now());
}

/**
 * Append a progress entry for a task. Returns the assigned sequence number.
 * Sequence numbers are monotonically increasing per task, starting at 1.
 *
 * Wrapped in an immediate transaction so the read-then-insert is atomic
 * relative to other writers using the same SQLite connection.
 */
export function appendActivity(taskId: string, message: string): { seq: number } {
  const conn = getDb();
  const insert = conn.transaction((tid: string, msg: string) => {
    const row = conn
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM task_activity WHERE task_id = ?`)
      .get(tid) as { max_seq: number };
    const seq = row.max_seq + 1;
    conn
      .prepare(`INSERT INTO task_activity (task_id, seq, message, created_at) VALUES (?, ?, ?, ?)`)
      .run(tid, seq, msg, Date.now());
    return seq;
  });
  return { seq: insert(taskId, message) };
}

/**
 * Return activity entries with seq > last_reported_seq for the task.
 * If the task is unknown, returns an empty array.
 */
export function getUnreportedActivity(taskId: string): TaskActivity[] {
  return getDb()
    .prepare(
      `SELECT a.task_id, a.seq, a.message, a.created_at
       FROM task_activity a
       JOIN tasks t ON t.id = a.task_id
       WHERE a.task_id = ? AND a.seq > t.last_reported_seq
       ORDER BY a.seq`
    )
    .all(taskId) as TaskActivity[];
}

/**
 * Move the task's reported watermark forward. The watermark only ever advances —
 * passing a smaller seq is a no-op so concurrent reporters stay safe.
 */
export function advanceReportedSeq(taskId: string, seq: number): void {
  getDb()
    .prepare(
      `UPDATE tasks SET last_reported_seq = ?, updated_at = ?
       WHERE id = ? AND last_reported_seq < ?`
    )
    .run(seq, Date.now(), taskId, seq);
}

export function getActivity(taskId: string): TaskActivity[] {
  return getDb()
    .prepare(
      `SELECT task_id, seq, message, created_at FROM task_activity WHERE task_id = ? ORDER BY seq`
    )
    .all(taskId) as TaskActivity[];
}
