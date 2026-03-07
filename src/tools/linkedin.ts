import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);
const SCRAPER_PATH = path.join(process.env.HOME!, "scripts", "linkedin_cdp_scraper.py");
const RESULTS_PATH = "/tmp/linkedin_jobs.json";

export const linkedinSearch: AgentTool = {
  name: "linkedin_search",
  label: "LinkedIn Job Search",
  description: "Search LinkedIn jobs via the CDP scraper. Requires Chrome running on port 18800 with a LinkedIn-authenticated session. Returns job listings with titles, companies, locations, and descriptions.",
  parameters: Type.Object({
    max_per_query: Type.Optional(Type.Number({ description: "Max jobs per search query. Default: 15" })),
    max_descriptions: Type.Optional(Type.Number({ description: "Max job descriptions to fetch. Default: 25" })),
  }),
  execute: async (_id, params: any) => {
    const maxPerQuery = params.max_per_query || 15;
    const maxDescriptions = params.max_descriptions || 25;

    try {
      const { stdout, stderr } = await execFileAsync("/opt/homebrew/bin/python3", [
        SCRAPER_PATH,
        "--max-per-query", String(maxPerQuery),
        "--max-descriptions", String(maxDescriptions),
      ], { timeout: 180000 }); // 3 min timeout

      // Read the results file
      let jobs: any[] = [];
      try {
        const data = await readFile(RESULTS_PATH, "utf-8");
        jobs = JSON.parse(data);
      } catch {
        // Results file might not exist if no jobs found
      }

      const summary = jobs.length > 0
        ? jobs.slice(0, 20).map(j =>
            `${j.company} | ${j.title} | ${j.location}${j.description ? ` | ${j.description.slice(0, 100)}...` : ""}`
          ).join("\n")
        : "No jobs found";

      const output = `${stdout}\n\n--- Top Results ---\n${summary}`;

      return {
        content: [{ type: "text", text: output }],
        details: { success: true, count: jobs.length, resultsPath: RESULTS_PATH },
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `LinkedIn scraper error: ${e.message}\n${e.stderr || ""}` }],
        details: { success: false, error: e.message },
      };
    }
  },
};

export const linkedinResults: AgentTool = {
  name: "linkedin_results",
  label: "LinkedIn Results",
  description: "Read the most recent LinkedIn job scrape results from /tmp/linkedin_jobs.json without running a new scrape.",
  parameters: Type.Object({
    limit: Type.Optional(Type.Number({ description: "Max results to return. Default: 20" })),
  }),
  execute: async (_id, params: any) => {
    const limit = params.limit || 20;
    try {
      const data = await readFile(RESULTS_PATH, "utf-8");
      const jobs = JSON.parse(data);
      const subset = jobs.slice(0, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(subset, null, 2) }],
        details: { success: true, total: jobs.length, returned: subset.length },
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `No results file found. Run linkedin_search first. Error: ${e.message}` }],
        details: { success: false },
      };
    }
  },
};
