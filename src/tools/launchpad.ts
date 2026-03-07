import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);
const LAUNCHPAD_DIR = path.join(process.env.HOME!, "max", "projects", "launchpad");

export const launchpadRunScraper: AgentTool = {
  name: "launchpad_run_scraper",
  label: "Run Launchpad Scraper",
  description: "Run the Launchpad job scraper pipeline (scrape, commit data, push to GitHub). Executes max_run_scraper_and_push.sh.",
  parameters: Type.Object({}),
  execute: async () => {
    const scriptPath = path.join(LAUNCHPAD_DIR, "scripts", "max_run_scraper_and_push.sh");
    try {
      const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
        timeout: 300000, // 5 min
        cwd: LAUNCHPAD_DIR,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: output || "Scraper completed" }], details: { success: true } };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Scraper failed: ${e.message}\n${e.stderr || ""}` }],
        details: { success: false, error: e.message },
      };
    }
  },
};

export const launchpadDeploy: AgentTool = {
  name: "launchpad_deploy",
  label: "Deploy Launchpad",
  description: "Deploy Launchpad to NAS Kubernetes cluster. Executes deploy-from-mac.sh.",
  parameters: Type.Object({}),
  execute: async () => {
    const scriptPath = path.join(LAUNCHPAD_DIR, "scripts", "deploy-from-mac.sh");
    try {
      const { stdout, stderr } = await execFileAsync("bash", [scriptPath], {
        timeout: 300000,
        cwd: LAUNCHPAD_DIR,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: output || "Deploy completed" }], details: { success: true } };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Deploy failed: ${e.message}\n${e.stderr || ""}` }],
        details: { success: false, error: e.message },
      };
    }
  },
};
