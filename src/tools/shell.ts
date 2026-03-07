import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const MAX_OUTPUT = 10000; // chars

export const runShell: AgentTool = {
  name: "run_shell",
  label: "Run Shell Command",
  description: "Run a shell command locally on the Mac. Use for launching apps, running scripts, system commands, etc. Commands run as the user via /bin/zsh.",
  parameters: Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in ms. Default: 30000 (30s). Max: 300000 (5m)" })),
    cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to home directory" })),
  }),
  execute: async (_id, params: any) => {
    const { command } = params;
    const timeout = Math.min(params.timeout || 30000, 300000);
    const cwd = params.cwd || process.env.HOME;

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout,
        cwd,
        shell: "/bin/zsh",
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ""}` },
      });

      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      const truncated = output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n...(truncated)" : output;
      return { content: [{ type: "text", text: truncated || "(no output)" }], details: { success: true } };
    } catch (e: any) {
      const output = [e.stdout || "", e.stderr || ""].filter(Boolean).join("\n").trim();
      const truncated = output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n...(truncated)" : output;
      return {
        content: [{ type: "text", text: `Command failed (exit ${e.code}): ${truncated || e.message}` }],
        details: { success: false, exitCode: e.code, error: e.message },
      };
    }
  },
};
