import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execFileAsync = promisify(execFile);

const BROWSER_AUTO_DIR = path.join(process.env.HOME!, "max/projects/browser-automation");
const VENV_PYTHON = path.join(BROWSER_AUTO_DIR, "venv/bin/python3.12");
const APPLY_SCRIPT = path.join(BROWSER_AUTO_DIR, "apply_to_job.py");
const DOORDASH_SCRIPT = path.join(BROWSER_AUTO_DIR, "doordash_order.py");

const NIX_A2A_URL = process.env.NIX_A2A_URL || "http://192.168.1.70:8771";
const A2A_SHARED_SECRET = process.env.A2A_SHARED_SECRET || "nix-a2a-secret-2026";

const JOB_RESULT_PATH = "/tmp/job_application_result.json";
const DOORDASH_RESULT_PATH = "/tmp/doordash_result.json";

/**
 * browser_task — Run agentic browser automation via browser-use.
 *
 * Routes to:
 * - apply_to_job.py: for job applications (LinkedIn Easy Apply)
 * - doordash_order.py: for DoorDash food ordering
 * - generic browser-use agent: for ad-hoc tasks
 *
 * Uses Claude claude-sonnet-4-6 via local proxy (ANTHROPIC_BASE_URL).
 */
export const browserTask: AgentTool = {
  name: "browser_task",
  label: "Browser: Agentic Task",
  description:
    "Run a complex browser automation task via browser-use (LLM + Playwright). " +
    "Use for: LinkedIn Easy Apply job applications, DoorDash ordering, " +
    "or any task that requires reasoning about a web page. " +
    "For apply: provide job URL in task or url field. " +
    "For order: describe restaurant and item. " +
    "For generic: describe the full task.",
  parameters: Type.Object({
    task: Type.String({
      description:
        "Natural language description of what to do. " +
        "Examples: 'apply to https://linkedin.com/jobs/view/123', " +
        "'order chicken pad thai from Noodle Box', " +
        "'find the pricing page of stripe.com and extract plan details'",
    }),
    url: Type.Optional(
      Type.String({ description: "Optional starting URL (e.g. job listing URL)" })
    ),
    profile: Type.Optional(
      Type.String({
        description:
          "Browser profile to use for saved sessions. Options: 'linkedin', 'doordash'. " +
          "Omit for generic tasks (uses fresh profile).",
      })
    ),
    cover_letter: Type.Optional(
      Type.String({ description: "Cover letter text for job applications" })
    ),
  }),
  execute: async (_id, params: any) => {
    const { task, url, profile, cover_letter } = params as {
      task: string;
      url?: string;
      profile?: string;
      cover_letter?: string;
    };

    const taskLower = task.toLowerCase();

    // Route: Job application
    const isJobTask =
      taskLower.includes("apply") ||
      taskLower.includes("job") ||
      taskLower.includes("linkedin") ||
      profile === "linkedin";

    // Route: DoorDash
    const isDoorDashTask =
      taskLower.includes("doordash") ||
      taskLower.includes("order") ||
      taskLower.includes("food") ||
      taskLower.includes("delivery") ||
      profile === "doordash";

    try {
      if (isJobTask && !isDoorDashTask) {
        return await runJobApplication(task, url, cover_letter);
      } else if (isDoorDashTask) {
        return await runDoorDashOrder(task, url);
      } else {
        // Generic browser-use tasks require ANTHROPIC_API_KEY for the Claude agent
        if (!process.env.ANTHROPIC_API_KEY) {
          return {
            content: [{ type: "text" as const, text: "browser_task (generic) requires ANTHROPIC_API_KEY to be set in .env — the browser-use agent uses Claude for reasoning. Please set this key and restart." }],
            details: { success: false, error: "ANTHROPIC_API_KEY not set" },
          };
        }
        return await runGenericTask(task, url, profile);
      }
    } catch (e: any) {
      const errMsg = `browser_task failed: ${e.message}`;
      notifyNix(errMsg).catch(() => {});
      return {
        content: [{ type: "text" as const, text: errMsg }],
        details: { success: false, error: e.message },
      };
    }
  },
};

async function runJobApplication(
  task: string,
  url?: string,
  coverLetter?: string
): Promise<any> {
  // Extract URL from task if not provided
  const jobUrl =
    url ||
    task.match(/https?:\/\/[^\s]+/)?.[0] ||
    task.match(/linkedin\.com\/jobs\/[^\s]+/)?.[0];

  if (!jobUrl) {
    return {
      content: [
        {
          type: "text" as const,
          text: "❌ browser_task (apply): No job URL found in task. Please provide a URL.",
        },
      ],
      details: { success: false, error: "No job URL" },
    };
  }

  const args = [APPLY_SCRIPT, jobUrl];
  if (coverLetter) {
    args.push("--cover-letter", coverLetter);
  }

  const { stdout, stderr } = await execFileAsync(VENV_PYTHON, args, {
    timeout: 300_000, // 5 min
    env: {
      ...process.env,
    },
  });

  let result: any = {};
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    result = { status: "unknown", message: stdout.slice(0, 500) };
  }

  const status = result.status === "success" ? "✅" : "❌";
  const summaryText = `${status} Job application: ${result.status} — ${result.message?.slice(0, 200)}`;

  notifyNix(summaryText).catch(() => {});

  return {
    content: [{ type: "text" as const, text: summaryText }],
    details: { success: result.status === "success", result, stderr: stderr?.slice(0, 300) },
  };
}

async function runDoorDashOrder(task: string, url?: string): Promise<any> {
  // Parse restaurant and item from task
  // e.g. "order chicken pad thai from Noodle Box"
  // e.g. "order Big Mac from McDonald's"
  const fromMatch = task.match(/(?:from|at)\s+(.+?)(?:\s*$|\s+and\b)/i);
  const restaurant = fromMatch?.[1]?.trim() || "unknown restaurant";

  // Item is everything between "order" and "from"
  const itemMatch = task.match(/(?:order|get|buy)\s+(.+?)\s+(?:from|at)/i);
  const item = itemMatch?.[1]?.trim() || task.replace(restaurant, "").replace(/order|from|at/gi, "").trim();

  const args = [DOORDASH_SCRIPT, restaurant, item || "chicken dish"];

  const { stdout, stderr } = await execFileAsync(VENV_PYTHON, args, {
    timeout: 300_000, // 5 min
    env: {
      ...process.env,
    },
  });

  let result: any = {};
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    result = { status: "unknown", message: stdout.slice(0, 500) };
  }

  const status = result.status === "success" ? "✅" : "❌";
  const eta = result.estimated_delivery ? ` ETA: ${result.estimated_delivery}` : "";
  const total = result.total ? ` Total: ${result.total}` : "";
  const summaryText = `${status} DoorDash order: ${result.status}${total}${eta} — ${result.message?.slice(0, 150)}`;

  notifyNix(summaryText).catch(() => {});

  return {
    content: [{ type: "text" as const, text: summaryText }],
    details: { success: result.status === "success", result, stderr: stderr?.slice(0, 300) },
  };
}

async function runGenericTask(task: string, url?: string, profile?: string): Promise<any> {
  // For ad-hoc tasks, run browser-use inline via a quick Python script
  const profileDir = profile
    ? path.join(BROWSER_AUTO_DIR, "profiles", profile)
    : null;

  const script = `
import asyncio, json, os, sys
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path.home() / "max/projects/agent-max/.env")
from browser_use import Agent
from browser_use.llm import ChatAnthropic
from browser_use.browser.profile import BrowserProfile

async def run():
    llm = ChatAnthropic(
        model=os.environ.get("FALLBACK_MODEL", "claude-sonnet-4-5"),
        api_key=os.environ.get("ANTHROPIC_API_KEY") or "dummy",
        base_url=os.environ.get("ANTHROPIC_BASE_URL"),
        max_tokens=4096,
    )
    profile_dir = ${profileDir ? `"${profileDir}"` : "None"}
    profile = BrowserProfile(user_data_dir=profile_dir, headless=True) if profile_dir else BrowserProfile(headless=True)
    task_text = """${task.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"')}"""
    agent = Agent(task=task_text, llm=llm, browser_profile=profile, max_failures=3)
    history = await agent.run(max_steps=20)
    result = history.final_result() if hasattr(history, "final_result") else str(history)
    print(json.dumps({"status": "success", "result": str(result)}))

asyncio.run(run())
`.trim();

  const { stdout, stderr } = await execFileAsync(VENV_PYTHON, ["-c", script], {
    timeout: 300_000,
    env: { ...process.env },
  });

  let result: any = {};
  try {
    const jsonLine = stdout.split("\n").find((l) => l.trim().startsWith("{"));
    if (jsonLine) result = JSON.parse(jsonLine);
    else result = { status: "done", result: stdout.trim() };
  } catch {
    result = { status: "done", result: stdout.slice(0, 500) };
  }

  const summaryText = `✅ Browser task done: ${String(result.result || result.status).slice(0, 300)}`;
  notifyNix(summaryText).catch(() => {});

  return {
    content: [{ type: "text" as const, text: summaryText }],
    details: { success: true, result, stderr: stderr?.slice(0, 300) },
  };
}

async function notifyNix(text: string): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (A2A_SHARED_SECRET) {
    headers["Authorization"] = `Bearer ${A2A_SHARED_SECRET}`;
  }

  const res = await fetch(`${NIX_A2A_URL}/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      params: {
        message: {
          parts: [{ type: "text", text }],
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Nix A2A returned ${res.status}`);
  }
}
