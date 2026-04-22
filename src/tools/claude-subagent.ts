import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { spawn, ChildProcess } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { log } from "../logger.js";
import { getAgentWeaveSession } from "../agentweave-context.js";
import { relayJobCompletionToTelegram } from "../telegram-notify.js";
import { headAndTail } from "./truncate.js";

type DelegateJobStatus = "running" | "completed" | "failed" | "timed_out";

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
  silent?: boolean;
};

const jobs = new Map<string, DelegateJob>();
const processes = new Map<string, ChildProcess>();

export const MAX_OUTPUT_CHARS = 15000;
const MAX_JOBS = 50;
const DEFAULT_MODEL = process.env.CLAUDE_SUBAGENT_MODEL || "claude-sonnet-4-6";

/**
 * Timeout in ms before a running subagent is killed.
 * Configurable via CLAUDE_SUBAGENT_TIMEOUT_MS (default: 5 minutes).
 *
 * Note: subagents run with --permission-mode bypassPermissions, which allows
 * the Claude CLI to perform file/shell operations without interactive prompts.
 * This is intentional for local trusted environments — do not expose this
 * agent to untrusted users or inputs.
 */
const JOB_TIMEOUT_MS = parseInt(process.env.CLAUDE_SUBAGENT_TIMEOUT_MS || "300000", 10);

// Persist job state to ~/.max-subagent-jobs/<jobId>.json so status survives restarts.
const JOBS_DIR = join(process.env.HOME || ".", ".max-subagent-jobs");
try {
  if (!existsSync(JOBS_DIR)) mkdirSync(JOBS_DIR, { recursive: true });
} catch {}

function persistJob(job: DelegateJob): void {
  try {
    writeFileSync(join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2), "utf8");
  } catch (err) {
    log("warn", `claude_subagent: failed to persist job ${job.id}: ${err}`);
  }
}

function loadJobFromDisk(jobId: string): DelegateJob | undefined {
  const diskPath = join(JOBS_DIR, `${jobId}.json`);
  if (!existsSync(diskPath)) return undefined;
  try {
    return JSON.parse(readFileSync(diskPath, "utf8")) as DelegateJob;
  } catch {
    return undefined;
  }
}

/**
 * Evict oldest completed/failed/timed_out jobs when we hit the cap.
 * Running jobs are never evicted.
 */
export function evictOldJobs(): void {
  if (jobs.size < MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => a.startedAt - b.startedAt);
  const toEvict = finished.slice(0, jobs.size - MAX_JOBS + 1);
  for (const j of toEvict) {
    jobs.delete(j.id);
  }
}

export function truncateOutput(text: string): string {
  // Keep head (initial plan/progress) and tail (final answer/errors).
  return headAndTail(text, MAX_OUTPUT_CHARS);
}

function makeCustomHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/**
 * Called when a subagent job reaches a terminal state (completed/failed/timed_out).
 * Updates in-memory + disk state, then fires a Telegram notification unless silent.
 * Also exported for use by the A2A /tasks/callback endpoint (cross-machine callbacks).
 *
 * Returns true if the job was found and updated, false if the jobId is unknown.
 */
export function receiveCallback(
  jobId: string,
  status: "completed" | "failed" | "timed_out",
  result?: string,
  error?: string
): boolean {
  // Prefer in-memory job; fall back to disk (handles cross-restart callbacks)
  const job = jobs.get(jobId) ?? loadJobFromDisk(jobId);
  if (!job) {
    log("warn", `receiveCallback: unknown job_id ${jobId}`);
    return false;
  }

  job.status = status;
  job.endedAt = job.endedAt ?? Date.now();
  if (result !== undefined) job.output = result;
  if (error !== undefined) job.error = error;

  // Re-insert into memory map in case it was loaded from disk
  jobs.set(jobId, job);
  persistJob(job);

  const elapsedSec = Math.round((job.endedAt - job.startedAt) / 1000);
  log("info", `claude_subagent ${job.id} finished: status=${status} elapsed=${elapsedSec}s label="${job.taskLabel}"`);

  if (!job.silent) {
    void relayJobCompletionToTelegram({
      taskLabel: job.taskLabel,
      status,
      durationMs: job.endedAt - job.startedAt,
      result: job.output,
      error: job.error,
    });
  }

  return true;
}

function startClaudeDelegation(prompt: string, taskLabel?: string, silent?: boolean): DelegateJob {
  evictOldJobs();

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

  const homeBin = `${process.env.HOME || ""}/.local/bin`;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [homeBin, process.env.PATH || ""].filter(Boolean).join(":"),
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
    silent: silent ?? false,
  };

  jobs.set(job.id, job);
  persistJob(job); // write initial "running" state immediately

  const claudeBin = `${process.env.HOME || ""}/.local/bin/claude`;
  const claude = spawn(
    claudeBin,
    ["--print", "--permission-mode", "bypassPermissions", "--model", DEFAULT_MODEL, prompt],
    {
      env: childEnv,
      cwd: process.env.HOME,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  processes.set(jobId, claude);

  // Kill and mark timed_out if the subagent runs too long
  const timeoutHandle = setTimeout(() => {
    if (job.status !== "running") return;
    log("warn", `claude_subagent ${job.id} timed out after ${JOB_TIMEOUT_MS / 1000}s — killing`);
    claude.kill("SIGTERM");
    job.endedAt = Date.now();
    processes.delete(jobId);
    receiveCallback(jobId, "timed_out", undefined, `Timed out after ${JOB_TIMEOUT_MS / 1000}s`);
  }, JOB_TIMEOUT_MS);

  claude.stdout.on("data", (chunk: Buffer) => {
    job.output = truncateOutput(job.output + chunk.toString("utf8"));
  });

  claude.stderr.on("data", (chunk: Buffer) => {
    job.output = truncateOutput(job.output + chunk.toString("utf8"));
  });

  claude.on("error", (err: Error) => {
    clearTimeout(timeoutHandle);
    job.endedAt = Date.now();
    processes.delete(jobId);
    receiveCallback(jobId, "failed", undefined, err.message);
  });

  claude.on("close", (code: number | null) => {
    clearTimeout(timeoutHandle);
    // Don't overwrite timed_out status set by the timeout handler
    if (job.status !== "running") return;
    job.exitCode = code;
    job.endedAt = Date.now();
    processes.delete(jobId);
    receiveCallback(
      jobId,
      code === 0 ? "completed" : "failed",
      job.output,
      code !== 0 ? `Exit code ${code}` : undefined
    );
  });

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

// ─── Test helpers (exported only for unit tests) ──────────────────────────────

export interface HeaderParams {
  childSessionId: string;
  parentSessionId: string;
  agentId: string;
  taskLabel: string;
  proxyToken?: string;
}

export function _buildAnthropicCustomHeadersForTest(params: HeaderParams): string {
  const headers: Record<string, string> = {
    "X-AgentWeave-Session-Id": params.childSessionId,
    "X-AgentWeave-Parent-Session-Id": params.parentSessionId,
    "X-AgentWeave-Agent-Id": params.agentId,
    "X-AgentWeave-Agent-Type": "subagent",
    "X-AgentWeave-Task-Label": params.taskLabel,
    ...(params.proxyToken ? { "X-AgentWeave-Proxy-Token": params.proxyToken } : {}),
  };
  return makeCustomHeaders(headers);
}

export function _clearJobsForTest(): void {
  jobs.clear();
}

export function _addJobForTest(job: DelegateJob): void {
  jobs.set(job.id, job);
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const delegateToClaudeSubagent: AgentTool = {
  name: "delegate_to_claude_subagent",
  label: "Delegate to Claude Code Subagent",
  description:
    "Run a Claude Code subagent task asynchronously. Use action=start to launch a background Claude CLI process " +
    "with AgentWeave session attribution, then action=status to retrieve output/results. " +
    `Jobs are killed after ${JOB_TIMEOUT_MS / 1000}s if still running.`,
  parameters: Type.Object({
    action: Type.String({ description: "start | status | list" }),
    prompt: Type.Optional(Type.String({ description: "Task prompt for action=start" })),
    task_label: Type.Optional(Type.String({ description: "Optional short label for trace attribution" })),
    job_id: Type.Optional(Type.String({ description: "Job id for action=status" })),
    silent: Type.Optional(
      Type.Boolean({ description: "If true, suppresses Telegram notification on completion" })
    ),
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

      const job = startClaudeDelegation(prompt, params.task_label, params.silent ?? false);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Started Claude subagent job ${job.id}. ` +
              `Use action=status with job_id=${job.id} to check progress. ` +
              `Will be killed after ${JOB_TIMEOUT_MS / 1000}s if still running.`,
          },
        ],
        details: {
          success: true,
          status: job.status,
          jobId: job.id,
          childSessionId: job.childSessionId,
          parentSessionId: job.parentSessionId,
          taskLabel: job.taskLabel,
          timeoutSec: JOB_TIMEOUT_MS / 1000,
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

      const job = jobs.get(jobId) ?? loadJobFromDisk(jobId);
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
          elapsedSec: Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000),
        },
      };
    }

    if (action === "list") {
      const allJobs = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
      if (allJobs.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No claude subagent jobs yet." }],
          details: { success: true, count: 0, jobs: [] },
        };
      }
      const lines = allJobs.map((j) => {
        const elapsedSec = Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000);
        return `${j.id} [${j.status}] ${j.taskLabel} (${elapsedSec}s)`;
      });
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          success: true,
          count: allJobs.length,
          jobs: allJobs.map((j) => ({ id: j.id, status: j.status, taskLabel: j.taskLabel })),
        },
      };
    }

    return {
      content: [{ type: "text" as const, text: `Invalid action: "${action}". Use start, status, or list` }],
      details: { success: false },
    };
  },
};
