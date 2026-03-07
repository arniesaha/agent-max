import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import path from "path";

const MAX_HOME = path.join(process.env.HOME!, "max");

function resolvePath(p: string): string {
  if (p.startsWith("~/max/")) return p.replace("~/max/", MAX_HOME + "/");
  if (p.startsWith("/")) return p;
  return path.join(MAX_HOME, p);
}

export const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",
  description: "Read the contents of a file. Paths are relative to ~/max/ by default.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to ~/max/ or absolute)" }),
  }),
  execute: async (_id, params: any) => {
    try {
      const resolved = resolvePath(params.path);
      const content = await readFile(resolved, "utf-8");
      return { content: [{ type: "text", text: content }], details: { path: resolved, size: content.length } };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error reading file: ${e.message}` }], details: { error: e.message } };
    }
  },
};

export const writeFileTool: AgentTool = {
  name: "write_file",
  label: "Write File",
  description: "Write content to a file. Paths are relative to ~/max/ by default.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to ~/max/ or absolute)" }),
    content: Type.String({ description: "Content to write" }),
  }),
  execute: async (_id, params: any) => {
    try {
      const resolved = resolvePath(params.path);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, params.content, "utf-8");
      return { content: [{ type: "text", text: `Written ${params.content.length} bytes to ${resolved}` }], details: { path: resolved } };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error writing file: ${e.message}` }], details: { error: e.message } };
    }
  },
};

export const listFilesTool: AgentTool = {
  name: "list_files",
  label: "List Files",
  description: "List files in a directory. Paths are relative to ~/max/ by default.",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Directory path (relative to ~/max/ or absolute)" })),
  }),
  execute: async (_id, params: any) => {
    try {
      const resolved = resolvePath(params.path || ".");
      const entries = await readdir(resolved, { withFileTypes: true });
      const lines = entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n");
      return { content: [{ type: "text", text: lines || "(empty directory)" }], details: { path: resolved, count: entries.length } };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error listing directory: ${e.message}` }], details: { error: e.message } };
    }
  },
};
