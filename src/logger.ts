import { appendFileSync, mkdirSync } from "fs";
import path from "path";

const LOG_DIR = path.join(process.env.HOME!, "max", "logs");
mkdirSync(LOG_DIR, { recursive: true });

function getLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `agent-${date}.log`);
}

export function log(level: "info" | "warn" | "error", message: string, data?: unknown): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(data ? { data } : {}),
  };

  const line = JSON.stringify(entry) + "\n";

  // Console
  if (level === "error") {
    console.error(line.trimEnd());
  } else {
    console.log(line.trimEnd());
  }

  // File
  try {
    appendFileSync(getLogPath(), line);
  } catch {
    // Don't crash on log failure
  }
}
