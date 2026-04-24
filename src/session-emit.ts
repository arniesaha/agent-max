import { execSync } from "child_process";
import { log } from "./logger.js";

interface EmitOptions {
  topic: string;
  projects?: string[];
  type?: "coding" | "conversation" | "research" | "maintenance";
  decisions?: string;
  next?: string;
  issues?: string[];
}

export function emitSessionArtifact(opts: EmitOptions): void {
  const script = `${process.env.HOME}/max/agent-shared/scripts/max-session-emit.sh`;
  const env = {
    ...process.env,
    SESSION_TOPIC: opts.topic,
    SESSION_PROJECTS: (opts.projects ?? []).join(","),
    SESSION_TYPE: opts.type ?? "maintenance",
    SESSION_DECISIONS: opts.decisions ?? "None.",
    SESSION_NEXT: opts.next ?? "None.",
    SESSION_ISSUES: (opts.issues ?? []).join(","),
  };
  try {
    execSync(`bash ${script}`, { env, timeout: 30_000, stdio: "pipe" });
    log("info", `Session artifact emitted: ${opts.topic}`);
  } catch (e: any) {
    log("warn", `Session emit failed: ${e.message}`);
  }
}

export function inferProjectsFromText(text: string): string[] {
  const known = [
    "launchpad", "nixclaw", "recall", "vault", "cortex", "mux",
    "agent-shared", "agent-max", "agentweave", "portfolio", "foundry",
    "linkedin-autopilot", "doordash", "nix-vision", "flight-tracker",
  ];
  const lower = text.toLowerCase();
  return known.filter((p) => lower.includes(p));
}
