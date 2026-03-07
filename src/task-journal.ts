import Database from "better-sqlite3";
import path from "path";
import { randomUUID } from "crypto";

const DB_PATH = path.join(process.env.HOME!, "max", "data", "task-journal.db");

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
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        source      TEXT NOT NULL,
        payload     TEXT NOT NULL,
        status      TEXT NOT NULL,
        result      TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        retry_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS agent_state (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
  }
  return db;
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
