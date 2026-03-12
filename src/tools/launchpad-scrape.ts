import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

const SCRAPER_PATH = path.join(
  process.env.HOME!,
  "max/projects/launchpad-scraper/linkedin_scraper.py"
);
const NIX_A2A_URL = process.env.NIX_A2A_URL || "http://192.168.1.70:8771";
const A2A_SHARED_SECRET = process.env.A2A_SHARED_SECRET || "nix-a2a-secret-2026";

/**
 * launchpad_scrape — Run LinkedIn scraper via PinchTab and POST results to NAS.
 *
 * This replaces the old SSH→CDP→scraper pipeline.
 * The scraper posts jobs directly to NAS /api/jobs/batch.
 * This tool notifies Nix of completion via A2A.
 */
export const launchpadScrape: AgentTool = {
  name: "launchpad_scrape",
  label: "Launchpad: Scrape LinkedIn Jobs",
  description:
    "Run the LinkedIn job scraper using PinchTab. Scrapes 6 search queries, " +
    "fetches descriptions, and POSTs new jobs to the NAS Launchpad API. " +
    "Triggered by Nix cron at 8:30 AM weekdays. Returns job count summary.",
  parameters: Type.Object({
    max_per_query: Type.Optional(
      Type.Number({ description: "Max jobs per search query. Default: 12" })
    ),
    max_descriptions: Type.Optional(
      Type.Number({ description: "Max descriptions to fetch. Default: 30" })
    ),
    dry_run: Type.Optional(
      Type.Boolean({ description: "Dry run — print what would be sent without POSTing" })
    ),
  }),
  execute: async (_id, params: any) => {
    const maxPerQuery = params.max_per_query || 12;
    const maxDescriptions = params.max_descriptions || 30;
    const dryRun = params.dry_run || false;

    const args = [
      SCRAPER_PATH,
      "--max-per-query", String(maxPerQuery),
      "--max-descriptions", String(maxDescriptions),
    ];
    if (dryRun) args.push("--dry-run");

    let summaryText = "";

    try {
      const { stdout, stderr } = await execFileAsync(
        "/Users/arnabmac/max/projects/browser-automation/venv/bin/python3",
        args,
        {
          timeout: 360_000, // 6 min
          env: {
            ...process.env,
            LAUNCHPAD_API_TOKEN: process.env.LAUNCHPAD_API_TOKEN || "",
            NAS_API_URL: "http://192.168.1.70:30895",
          },
        }
      );

      // stdout is JSON summary from scraper
      let summary: any = {};
      try {
        // stdout may have extra lines — find the JSON line
        const jsonLine = stdout
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("{"));
        if (jsonLine) summary = JSON.parse(jsonLine);
      } catch {
        // fallback
      }

      const scraped = summary.scraped ?? "?";
      const newJobs = summary.new ?? "?";
      const skipped = summary.skipped ?? "?";
      const errors = summary.errors?.length ? summary.errors.join("; ") : null;

      summaryText = dryRun
        ? `[DRY RUN] Would scrape ~${scraped} jobs across 6 queries`
        : `LinkedIn scrape done: ${scraped} scraped, ${newJobs} new, ${skipped} skipped`;

      if (errors) summaryText += ` | Errors: ${errors}`;

      // Notify Nix via A2A (non-blocking fire-and-forget)
      if (!dryRun) {
        notifyNix(summaryText).catch((e) => {
          console.error("Failed to notify Nix:", e.message);
        });
      }

      return {
        content: [{ type: "text" as const, text: summaryText }],
        details: { success: true, summary, stderr: stderr.slice(0, 500) },
      };
    } catch (e: any) {
      const errMsg = `LinkedIn scraper failed: ${e.message}`;

      // Check for session expiry
      if (
        e.code === 1 ||
        e.stderr?.includes("session expired") ||
        e.message?.includes("session expired")
      ) {
        const sessionMsg =
          "⚠️ LinkedIn session expired — Arnab needs to log in via PinchTab headed instance. " +
          "See ~/max/projects/launchpad-scraper/README.md for instructions.";
        notifyNix(sessionMsg).catch(() => {});
        return {
          content: [{ type: "text" as const, text: sessionMsg }],
          details: { success: false, sessionExpired: true },
        };
      }

      notifyNix(errMsg).catch(() => {});
      return {
        content: [{ type: "text" as const, text: errMsg }],
        details: { success: false, error: e.message, stderr: e.stderr },
      };
    }
  },
};

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
