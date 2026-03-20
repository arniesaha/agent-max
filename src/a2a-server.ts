import express from "express";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createTask, updateTaskStatus, getRecentTasks, getDb } from "./task-journal.js";
import { setAgentWeaveSession, resetAgentWeaveSession } from "./agentweave-context.js";
import { log } from "./logger.js";
import { saveSession } from "./session.js";

const A2A_PORT = parseInt(process.env.A2A_PORT || "8770", 10);
const A2A_SHARED_SECRET = process.env.A2A_SHARED_SECRET || "";
const startTime = Date.now();

const AGENTWEAVE_MAX_PROXY = 'http://192.168.1.70:30401';

const AGENT_CARD = {
  name: "Max",
  description: "Local compute and browser agent on Mac Mini",
  url: process.env.MAX_A2A_URL || `http://localhost:${A2A_PORT}`,
  capabilities: {
    streaming: true,
    async_tasks: true,
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

  // Agent Card — public, no auth
  app.get("/.well-known/agent.json", (_req, res) => {
    res.json(AGENT_CARD);
  });

  // Health — public
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

  // A2A Task submission
  app.post("/tasks", authMiddleware, async (req, res) => {
    if (agent.state.isStreaming) {
      res.status(409).json({ error: "Agent is busy processing another request" });
      return;
    }

    let taskId: string | undefined;

    // Extract AgentWeave context from incoming request (set by Nix)
    const parentSessionId = req.headers['x-agentweave-parent-session-id'] as string | undefined;
    const delegatedSessionId = req.headers['x-agentweave-delegated-session-id'] as string | undefined;
    const callerAgentId = req.headers['x-agentweave-agent-id'] as string | undefined;
    const taskLabel = req.headers['x-agentweave-task-label'] as string | undefined;
    const AGENTWEAVE_PROXY_TOKEN = process.env.AGENTWEAVE_PROXY_TOKEN;

    try {
      const { params } = req.body;
      if (!params?.message?.parts?.[0]?.text) {
        res.status(400).json({ error: "Missing message text" });
        return;
      }

      const text = params.message.parts[0].text;
      log("info", `A2A task from Nix: ${text.slice(0, 100)}`);

      const task = createTask("a2a_task", "nix", { text, metadata: params.metadata });
      taskId = task.id;
      updateTaskStatus(task.id, "working");

      // Set AgentWeave session context if parent session is provided
      if (parentSessionId) {
        const sessionId = delegatedSessionId || `max-a2a-${task.id}`;
        try {
          await fetch(`${AGENTWEAVE_MAX_PROXY}/session`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(AGENTWEAVE_PROXY_TOKEN ? { 'Authorization': `Bearer ${AGENTWEAVE_PROXY_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              session_id: sessionId,
              parent_session_id: parentSessionId,
              task_label: taskLabel || `a2a from ${callerAgentId || 'nix'}`,
              agent_type: 'delegated',
            }),
          });
          log('info', `AgentWeave session set: ${sessionId} (parent: ${parentSessionId})`);
          setAgentWeaveSession(sessionId);
        } catch (e: any) {
          log('warn', `AgentWeave session set failed: ${e.message}`);
        }
      }

      // Run agent
      let responseText = "";
      const unsub = agent.subscribe((event: AgentEvent) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          responseText += event.assistantMessageEvent.delta;
        }
      });

      await agent.prompt(text);
      unsub();

      if (!responseText) {
        const lastMsg = agent.state.messages[agent.state.messages.length - 1];
        if (lastMsg && "content" in lastMsg && lastMsg.role === "assistant") {
          responseText = lastMsg.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("");
        }
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
      // Restore Max's default session after delegated task completes
      if (parentSessionId) {
        resetAgentWeaveSession();
        fetch(`${AGENTWEAVE_MAX_PROXY}/session`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(AGENTWEAVE_PROXY_TOKEN ? { 'Authorization': `Bearer ${AGENTWEAVE_PROXY_TOKEN}` } : {}),
          },
          body: JSON.stringify({
            session_id: 'max-main',
            parent_session_id: '',
            task_label: '',
            agent_type: 'main',
          }),
        }).catch(() => {});
      }
    }
  });

  // Streaming task submission (SSE)
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

      // SSE headers
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
            sendEvent("tool_start", {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            });
            break;
          case "tool_execution_end":
            sendEvent("tool_end", {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
            });
            break;
          case "agent_end":
            // handled after prompt completes
            break;
        }
      });

      await agent.prompt(text);
      unsub();

      // Extract final response
      let responseText = "";
      const lastMsg = agent.state.messages[agent.state.messages.length - 1];
      if (lastMsg && "content" in lastMsg && lastMsg.role === "assistant") {
        responseText = lastMsg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
      }

      updateTaskStatus(task.id, "completed", { response: responseText });
      saveSession(agent);
      sendEvent("task_end", { taskId: task.id });
      res.end();
    } catch (e: any) {
      agent.abort();
      log("error", `A2A stream error: ${e.message}`);
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
        res.end();
      } catch {
        // response already closed
      }
    }
  });

  // Messages — returns conversation history
  app.get("/messages", authMiddleware, (_req, res) => {
    const messages = agent.state.messages
      .filter((m: any) => m.role === "user" || m.role === "assistant")
      .map((m: any) => {
        const text = typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("")
            : "";
        return { role: m.role, text };
      });
    res.json({ messages });
  });

  // Task status query
  app.get("/tasks/:id", authMiddleware, (req, res) => {
    const task = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
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
