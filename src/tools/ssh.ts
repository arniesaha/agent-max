import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const NAS_HOST = process.env.NAS_HOST || "localhost";
const NAS_USER = process.env.NAS_USER || "";

export const sshToNas: AgentTool = {
  name: "ssh_to_nas",
  label: "SSH to NAS",
  description: "Run a command on the NAS via SSH",
  parameters: Type.Object({
    command: Type.String({ description: "Shell command to execute on the NAS" }),
  }),
  execute: async (_id, params: any) => {
    const { command } = params;
    try {
      const { stdout, stderr } = await execFileAsync("/usr/bin/ssh", [
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=no",
        `${NAS_USER}@${NAS_HOST}`,
        command,
      ], { timeout: 60000 });

      const output = [stdout, stderr].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: output || "(no output)" }], details: { success: true } };
    } catch (e: any) {
      return { content: [{ type: "text", text: `SSH error: ${e.message}\n${e.stderr || ""}` }], details: { success: false } };
    }
  },
};
