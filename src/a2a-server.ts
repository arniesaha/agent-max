import express from "express";
import { Worker } from "worker_threads";
import { context, propagation, trace } from "@opentelemetry/api";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createTask, updateTaskStatus, getRecentTasks, getDb } from "./task-journal.js";
import { setAgentWeaveSession, resetAgentWeaveSession } from "./agentweave-context.js";
import { log } from "./logger.js";
import { saveSession } from "./session.js";
import { extractAssistantTextFromTurn } from "./response.js";
import type { WorkerProgressEvent } from "./worker.js";
import { relayTaskUpdateToTelegram, relayJobCompletionToTelegram } from "./telegram-notify.js";
import { receiveCallback } from "./tools/claude-subagent.js";

const A2A_PORT = parseInt(process.env.A2A_PORT || "8770", 10);
const A2A_SHARED_SECRET = process.env.A2A_SHARED_SECRET || "";
const startTime = Date.now();

const AGENTWEAVE_MAX_PROXY = process.env.AGENTWEAVE_PROXY_URL || "http://arnabsnas.local:30400";

const AGENT_CARD = {
  name: "Max",
  description: "Self-hosted AI agent with browser automation and distributed compute",
  url: process.env.MAX_A2A_URL || `http://localhost:${A2A_PORT}`,
  capabilities: {
    streaming: true,
    async_tasks: true,
    callback_endpoint: true,
  },
  skills: [
    "browser_control",
    "linkedin_scraper",
    "gpu_wake",
    "gpu_shutdown",
    "file_system",
    "ssh_to_nas",
  ],
};

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!A2A_SHARED_SECRET) return next();

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${A2A_SHARED_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function createA2AServer(agent: Agent): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/.well-known/agent.json", (_req, res) => {
    res.json(AGENT_CARD);
  });

  app.get("/health", (_req, res) => {
    const uptime = Math.round((Date.now() - startTime) / 1000);
    const recent = getRecentTasks(1);
    res.json({
      status: "ok",
      uptime,
      isStreaming: agent.state.isStreaming,
      messagesInContext: agent.state.messages.length,
      lastTask: recent[0] ? { id: recent[0].id, status: recent[0].status, type: recent[0].type } : null,
    });
  });

  app.post("/tasks", authMiddleware, async (req, res) => {
    let taskId: string | undefined;

    const parentSessionId = req.headers["x-agentweave-parent-session-id"] as string | undefined;
    const delegatedSessionId = req.headers["x-agentweave-delegated-session-id"] as string | undefined;
    const callerAgentId = req.headers["x-agentweave-agent-id"] as string | undefined;
    const taskLabel = req.headers["x-agentweave-task-label"] as string | undefined;
    const AGENTWEAVE_PROXY_TOKEN = process.env.AGENTWEAVE_PROXY_TOKEN;

    // Extract W3C traceparent from incoming request (for Nix → Max delegations).
    // This creates a new context with the incoming trace parent, which the worker
    // can use to link its execution as a child span.
    const incomingContext = propagation.extract(context.active(), req.headers);

    try {
      const { params } = req.body;
      if (!params?.message?.parts?.[0]?.text) {
        res.status(400).json({ error: "Missing message text" });
        return;
      }

      const text = params.message.parts[0].text;
      const isSync = String(req.query.sync || "false").toLowerCase() === "true";
      log("info", `A2A task from ${callerAgentId || "unknown"} (${isSync ? "sync" : "async"}): ${text.slice(0, 100)}`);

      const task = createTask("a2a_task", "nix", { text, metadata: params.metadata });
      taskId = task.id;
      updateTaskStatus(task.id, "working");

      if (!isSync) {
        const workerStartTime = Date.now();
        const isSilent = params.metadata?.silent === true;

        // Run worker within the extracted context (if present), so the worker's tracer
        // can create child spans under the incoming trace parent.
        const executeWorker = async () => {
          const worker = new Worker(new URL("./worker.js", import.meta.url), {
            workerData: {
              taskId: task.id,
              text,
              parentSessionId,
              delegatedSessionId,
              callerAgentId,
              taskLabel,
            },
          });

          worker.on("message", (event: WorkerProgressEvent) => {
            if (event.taskId !== task.id) return;

            if (event.type === "progress") {
              updateTaskStatus(task.id, "working", { progress: event.message || "Working" });
              if (event.message) {
                void relayTaskUpdateToTelegram(task.id, event.message);
              }
            } else if (event.type === "complete") {
              updateTaskStatus(task.id, "completed", { response: event.result || "" });
              if (!isSilent) {
                void relayJobCompletionToTelegram({
                  taskLabel: taskLabel || task.id,
                  status: "completed",
                  durationMs: Date.now() - workerStartTime,
                  result: event.result || "",
                });
              }
              worker.terminate().catch(() => {});
            } else if (event.type === "error") {
              updateTaskStatus(task.id, "failed", { error: event.error || "Unknown error" });
              if (!isSilent) {
                void relayJobCompletionToTelegram({
                  taskLabel: taskLabel || task.id,
                  status: "failed",
                  durationMs: Date.now() - workerStartTime,
                  error: event.error || "Unknown error",
                });
              }
              worker.terminate().catch(() => {});
            }
          });

          worker.on("error", (err: any) => {
            log("error", `Worker thread error for task ${task.id}: ${err.message}`);
            updateTaskStatus(task.id, "failed", { error: err.message });
            if (!isSilent) {
              void relayJobCompletionToTelegram({
                taskLabel: taskLabel || task.id,
                status: "failed",
                durationMs: Date.now() - workerStartTime,
                error: err.message,
              });
            }
          });

          worker.on("exit", (code) => {
            if (code !== 0) {
              log("warn", `Worker for task ${task.id} exited with code ${code}`);
            }
          });
        };

        // Execute the worker within the incoming trace context (if present)
        await context.with(incomingContext, executeWorker);

        res.status(202).json({
          jsonrpc: "2.0",
          id: req.body.id,
          result: {
            id: task.id,
            status: { state: "working" },
          },
        });
        return;
      }

      if (agent.state.isStreaming) {
        res.status(409).json({ error: "Agent is busy processing another request" });
        return;
      }

      if (parentSessionId) {
        const sessionId = delegatedSessionId || `max-a2a-${task.id}`;
        try {
          await fetch(`${AGENTWEAVE_MAX_PROXY}/session`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(AGENTWEAVE_PROXY_TOKEN ? { Authorization: `Bearer ${AGENTWEAVE_PROXY_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              session_id: sessionId,
              parent_session_id: parentSessionId,
              task_label: taskLabel || `a2a from ${callerAgentId || "nix"}`,
              agent_type: "delegated",
            }),
          });
          log("info", `AgentWeave session set: ${sessionId} (parent: ${parentSessionId})`);
          setAgentWeaveSession(sessionId);
        } catch (e: any) {
          log("warn", `AgentWeave session set failed: ${e.message}`);
        }
      }

      // Execute sync task within the incoming trace context as well
      const executeSyncTask = async () => {
        let responseText = "";
        const turnStartIndex = agent.state.messages.length;
        const unsub = agent.subscribe((event: AgentEvent) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            responseText += event.assistantMessageEvent.delta;
          }
        });

        await agent.prompt(text);
        unsub();

        if (!responseText) {
          responseText = extractAssistantTextFromTurn(agent.state.messages as any, turnStartIndex);
        }

        updateTaskStatus(task.id, "completed", { response: responseText });
        saveSession(agent);

        res.json({
          jsonrpc: "2.0",
          id: req.body.id,
          result: {
            id: task.id,
            status: { state: "completed" },
            artifacts: [
              {
                parts: [{ type: "text", text: responseText }],
              },
            ],
          },
        });
      };

      await context.with(incomingContext, executeSyncTask);
    } catch (e: any) {
      agent.abort();
      log("error", `A2A task error: ${e.message}`);
      if (taskId) updateTaskStatus(taskId, "failed", { error: e.message });
      res.status(500).json({
        jsonrpc: "2.0",
        id: req.body?.id,
        error: { code: -32000, message: e.message },
      });
    } finally {
      if (parentSessionId && String(req.query.sync || "false").toLowerCase() === "true") {
        resetAgentWeaveSession();
        fetch(`${AGENTWEAVE_MAX_PROXY}/session`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(AGENTWEAVE_PROXY_TOKEN ? { Authorization: `Bearer ${AGENTWEAVE_PROXY_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            session_id: "max-main",
            parent_session_id: "",
            task_label: "",
            agent_type: "main",
          }),
        }).catch(() => {});
      }
    }
  });

  app.post("/tasks/stream", authMiddleware, async (req, res) => {
    if (agent.state.isStreaming) {
      res.status(409).json({ error: "Agent is busy processing another request" });
      return;
    }

    try {
      const { params } = req.body;
      if (!params?.message?.parts?.[0]?.text) {
        res.status(400).json({ error: "Missing message text" });
        return;
      }

      const text = params.message.parts[0].text;
      log("info", `A2A stream task: ${text.slice(0, 100)}`);

      const task = createTask("a2a_stream", "tui", { text });
      updateTaskStatus(task.id, "working");

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Task-Id": task.id,
      });

      const sendEvent = (type: string, data: any) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent("task_start", { taskId: task.id });

      const unsub = agent.subscribe((event: AgentEvent) => {
        switch (event.type) {
          case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
              sendEvent("text_delta", { delta: event.assistantMessageEvent.delta });
            }
            break;
          case "tool_execution_start":
            sendEvent("tool_start", { toolName: event.toolName });
            break;
          case "tool_execution_end":
            sendEvent("tool_end", { toolName: event.toolName });
            break;
        }
      });

      await agent.prompt(text);
      unsub();
      saveSession(agent);

      updateTaskStatus(task.id, "completed", { response: "(streamed)" });
      sendEvent("task_end", { taskId: task.id, status: "completed" });
      res.end();
    } catch (e: any) {
      agent.abort();
      log("error", `A2A stream error: ${e.message}`);
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    }
  });

  app.get("/tasks/:id", authMiddleware, (req, res) => {
    const task = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  });

  /**
   * POST /tasks/callback
   * Called by Nix (or any external agent) when an async subagent job completes.
   * Body: { jobId: string, status: 'completed' | 'failed' | 'timed_out', result?: string, error?: string }
   */
  app.post("/tasks/callback", authMiddleware, (req, res) => {
    const { jobId, status, result, error } = req.body as {
      jobId?: string;
      status?: string;
      result?: string;
      error?: string;
    };

    if (!jobId || typeof jobId !== "string") {
      res.status(400).json({ error: "Missing or invalid jobId" });
      return;
    }

    const validStatuses = ["completed", "failed", "timed_out"] as const;
    type CallbackStatus = (typeof validStatuses)[number];
    if (!status || !validStatuses.includes(status as CallbackStatus)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      return;
    }

    let found = false;
    try {
      found = receiveCallback(jobId, status as CallbackStatus, result, error);
    } catch (e: any) {
      log("error", `POST /tasks/callback error for job ${jobId}: ${e.message}`);
      res.status(500).json({ error: "Internal error processing callback" });
      return;
    }

    if (!found) {
      res.status(404).json({ error: `Unknown jobId: ${jobId}` });
      return;
    }

    res.status(200).json({ ok: true, jobId, status });
  });

  return app;
}

export function startA2AServer(agent: Agent): void {
  const app = createA2AServer(agent);
  app.listen(A2A_PORT, "0.0.0.0", () => {
    log("info", `A2A server listening on http://0.0.0.0:${A2A_PORT}`);
    log("info", `Agent card at http://0.0.0.0:${A2A_PORT}/.well-known/agent.json`);
    log("info", `Health at http://0.0.0.0:${A2A_PORT}/health`);
  });
}
