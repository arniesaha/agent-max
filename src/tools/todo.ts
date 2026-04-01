import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export interface Todo {
  id: string;
  task: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  createdAt: number;
  updatedAt: number;
}

const TODOS_PATH = path.join(process.env.HOME ?? "/tmp", "max", "data", "todos.json");

async function readTodos(): Promise<Todo[]> {
  try {
    const raw = await readFile(TODOS_PATH, "utf-8");
    return JSON.parse(raw) as Todo[];
  } catch {
    return [];
  }
}

async function writeTodos(todos: Todo[]): Promise<void> {
  const dir = path.dirname(TODOS_PATH);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(TODOS_PATH, JSON.stringify(todos, null, 2), "utf-8");
}

export async function loadActiveTodos(): Promise<Todo[]> {
  const todos = await readTodos();
  return todos.filter((t) => t.status === "pending" || t.status === "in_progress");
}

export const manageTodos: AgentTool = {
  name: "manage_todos",
  label: "Manage Todos",
  description: "Manage a persistent todo list. Supports list, add, update, and clear_done actions.",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("add"),
      Type.Literal("update"),
      Type.Literal("clear_done"),
    ], { description: "Action to perform" }),
    task: Type.Optional(Type.String({ description: "Task description (required for add)" })),
    id: Type.Optional(Type.String({ description: "Todo ID (required for update)" })),
    status: Type.Optional(Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("done"),
      Type.Literal("blocked"),
    ], { description: "New status (required for update)" })),
  }),
  execute: async (_toolCallId: string, params: unknown) => {
    const { action, task, id, status } = params as {
      action: string;
      task?: string;
      id?: string;
      status?: string;
    };

    const todos = await readTodos();

    if (action === "list") {
      if (todos.length === 0) {
        return { content: [{ type: "text" as const, text: "No todos found." }], details: {} };
      }
      const lines = todos.map(
        (t) => `[${t.id.slice(0, 8)}] [${t.status}] ${t.task}`
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    }

    if (action === "add") {
      if (!task) {
        return { content: [{ type: "text" as const, text: "Error: task is required for add" }], details: {} };
      }
      const now = Date.now();
      const todo: Todo = {
        id: randomUUID(),
        task,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      todos.push(todo);
      await writeTodos(todos);
      return { content: [{ type: "text" as const, text: `Added todo: [${todo.id.slice(0, 8)}] ${todo.task}` }], details: {} };
    }

    if (action === "update") {
      if (!id || !status) {
        return { content: [{ type: "text" as const, text: "Error: id and status are required for update" }], details: {} };
      }
      const todo = todos.find((t) => t.id.startsWith(id));
      if (!todo) {
        return { content: [{ type: "text" as const, text: `Error: todo not found with id prefix: ${id}` }], details: {} };
      }
      todo.status = status as Todo["status"];
      todo.updatedAt = Date.now();
      await writeTodos(todos);
      return { content: [{ type: "text" as const, text: `Updated [${todo.id.slice(0, 8)}] to ${status}` }], details: {} };
    }

    if (action === "clear_done") {
      const before = todos.length;
      const remaining = todos.filter((t) => t.status !== "done");
      await writeTodos(remaining);
      return { content: [{ type: "text" as const, text: `Cleared ${before - remaining.length} done todo(s).` }], details: {} };
    }

    return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], details: {} };
  },
};
