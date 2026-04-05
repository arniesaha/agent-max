import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { spawn } from "child_process";
import { log } from "../logger.js";
import { getAgentWeaveSession } from "../agentweave-context.js";

type DelegateJobStatus = "running" | "completed" | "failed";

type DelegateJob = {
  id: string;
  taskLabel: string;
  prompt: string;
  childSessionId: string;
  parentSessionId: string;
  startedAt: number;
  endedAt?: number;
  status: DelegateJobStatus;
  exitCode?: number | null;
  output: string;
  error?: string;
};

const jobs = new Map<string, DelegateJob>();
const MAX_OUTPUT_CHARS = 15000;
const DEFAULT_MODEL = process.env.CLAUDE_SUBAGENT_MODEL || "claude-sonnet-4-6";

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(text.length - MAX_OUTPUT_CHARS);
}

function makeCustomHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function startClaudeDelegation(prompt: string, taskLabel?: string): DelegateJob {
  const jobId = crypto.randomUUID();
  const parentSessionId = getAgentWeaveSession();
  const childSessionId = `max-claude-subagent-${jobId}`;
  const label = taskLabel?.trim() || `claude_subagent:${prompt.slice(0, 60)}`;

  const attributionHeaders: Record<string, string> = {
    "X-AgentWeave-Session-Id": childSessionId,
    "X-AgentWeave-Parent-Session-Id": parentSessionId,
    "X-AgentWeave-Agent-Id": process.env.AGENTWEAVE_AGENT_ID || "max-v1",
    "X-AgentWeave-Agent-Type": "subagent",
    "X-AgentWeave-Task-Label": label,
    ...(process.env.AGENTWEAVE_PROXY_TOKEN
      ? { "X-AgentWeave-Proxy-Token": process.env.AGENTWEAVE_PROXY_TOKEN }
      : {}),
  };

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_CUSTOM_HEADERS: makeCustomHeaders(attributionHeaders),
    AGENTWEAVE_SESSION_ID: childSessionId,
    AGENTWEAVE_PARENT_SESSION_ID: parentSessionId,
    AGENTWEAVE_AGENT_ID: process.env.AGENTWEAVE_AGENT_ID || "max-v1",
    AGENTWEAVE_AGENT_TYPE: "subagent",
    AGENTWEAVE_TASK_LABEL: label,
  };

  const job: DelegateJob = {
    id: jobId,
    taskLabel: label,
    prompt,
    childSessionId,
    parentSessionId,
    startedAt: Date.now(),
    status: "running",
    output: "",
  };

  const claude = spawn(
    "claude",
    ["--print", "--permission-mode", "bypassPermissions", "--model", DEFAULT_MODEL, prompt],
    {
      env: childEnv,
      cwd: process.env.HOME,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  claude.stdout.on("data", (chunk) => {
    job.output = truncateOutput(job.output + chunk.toString("utf8"));
  });

  claude.stderr.on("data", (chunk) => {
    job.output = truncateOutput(job.output + chunk.toString("utf8"));
  });

  claude.on("error", (err) => {
    job.status = "failed";
    job.error = err.message;
    job.endedAt = Date.now();
    log("error", `claude_subagent spawn failed (${job.id}): ${err.message}`);
  });

  claude.on("close", (code) => {
    job.exitCode = code;
    job.endedAt = Date.now();
    job.status = code === 0 ? "completed" : "failed";
    log("info", `claude_subagent ${job.id} finished with code ${code}`);
  });

  jobs.set(job.id, job);
  return job;
}

function summarizeJob(job: DelegateJob): string {
  const elapsedMs = (job.endedAt || Date.now()) - job.startedAt;
  const elapsedSec = Math.round(elapsedMs / 1000);
  const output = job.output.trim() || "(no output yet)";
  return [
    `job_id: ${job.id}`,
    `status: ${job.status}`,
    `task_label: ${job.taskLabel}`,
    `parent_session_id: ${job.parentSessionId}`,
    `child_session_id: ${job.childSessionId}`,
    `elapsed_sec: ${elapsedSec}`,
    ...(job.exitCode !== undefined ? [`exit_code: ${job.exitCode}`] : []),
    ...(job.error ? [`error: ${job.error}`] : []),
    "output:",
    output,
  ].join("\n");
}

export const delegateToClaudeSubagent: AgentTool = {
  name: "delegate_to_claude_subagent",
  label: "Delegate to Claude Code Subagent",
  description:
    "Run a Claude Code subagent task asynchronously. Use action=start to launch a background Claude CLI process with AgentWeave session attribution, then action=status to retrieve output/results.",
  parameters: Type.Object({
    action: Type.String({ description: "start | status | list" }),
    prompt: Type.Optional(Type.String({ description: "Task prompt for action=start" })),
    task_label: Type.Optional(Type.String({ description: "Optional short label for trace attribution" })),
    job_id: Type.Optional(Type.String({ description: "Job id for action=status" })),
  }),
  execute: async (_id, params: any) => {
    const action = String(params.action || "").toLowerCase();

    if (action === "start") {
      const prompt = String(params.prompt || "").trim();
      if (!prompt) {
        return {
          content: [{ type: "text" as const, text: "Missing required field: prompt" }],
          details: { success: false },
        };
      }

      const job = startClaudeDelegation(prompt, params.task_label);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Started Claude subagent job ${job.id}. ` +
              `Use delegate_to_claude_subagent with action=status and job_id=${job.id} to fetch progress/result.`,
          },
        ],
        details: {
          success: true,
          status: job.status,
          jobId: job.id,
          childSessionId: job.childSessionId,
          parentSessionId: job.parentSessionId,
          taskLabel: job.taskLabel,
        },
      };
    }

    if (action === "status") {
      const jobId = String(params.job_id || "").trim();
      if (!jobId) {
        return {
          content: [{ type: "text" as const, text: "Missing required field: job_id" }],
          details: { success: false },
        };
      }

      const job = jobs.get(jobId);
      if (!job) {
        return {
          content: [{ type: "text" as const, text: `Unknown job_id: ${jobId}` }],
          details: { success: false, jobId },
        };
      }

      return {
        content: [{ type: "text" as const, text: summarizeJob(job) }],
        details: {
          success: true,
          status: job.status,
          jobId: job.id,
          childSessionId: job.childSessionId,
          parentSessionId: job.parentSessionId,
          taskLabel: job.taskLabel,
          completed: job.status !== "running",
          exitCode: job.exitCode,
        },
      };
    }

    if (action === "list") {
      const all = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10);
      const text = all.length
        ? all.map((j) => `${j.id} | ${j.status} | ${j.taskLabel}`).join("\n")
        : "No claude subagent jobs yet.";
      return {
        content: [{ type: "text" as const, text }],
        details: { success: true, count: all.length },
      };
    }

    return {
      content: [{ type: "text" as const, text: `Invalid action: ${action}. Use start, status, or list.` }],
      details: { success: false },
    };
  },
};

export function _buildAnthropicCustomHeadersForTest(input: {
  childSessionId: string;
  parentSessionId: string;
  agentId: string;
  taskLabel: string;
  proxyToken?: string;
}): string {
  return makeCustomHeaders({
    "X-AgentWeave-Session-Id": input.childSessionId,
    "X-AgentWeave-Parent-Session-Id": input.parentSessionId,
    "X-AgentWeave-Agent-Id": input.agentId,
    "X-AgentWeave-Agent-Type": "subagent",
    "X-AgentWeave-Task-Label": input.taskLabel,
    ...(input.proxyToken ? { "X-AgentWeave-Proxy-Token": input.proxyToken } : {}),
  });
}
