import { readFile } from "fs/promises";
import path from "path";
import { log } from "./logger.js";

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: "allow" | "deny";
  reason?: string;
}

export const DEFAULT_DENY_RULES: PermissionRule[] = [
  { tool: "runShell", pattern: "rm -rf", action: "deny", reason: "Recursive force delete is not allowed" },
  { tool: "runShell", pattern: "sudo rm", action: "deny", reason: "Sudo delete is not allowed" },
  { tool: "runShell", pattern: "mkfs", action: "deny", reason: "Filesystem formatting is not allowed" },
  { tool: "runShell", pattern: "format", action: "deny", reason: "Disk formatting is not allowed" },
  { tool: "runShell", pattern: ":(){:|:&};:", action: "deny", reason: "Fork bomb is not allowed" },
  { tool: "runShell", pattern: "dd if=", action: "deny", reason: "Direct disk write is not allowed" },
  { tool: "runShell", pattern: "> /dev/", action: "deny", reason: "Writing to device files is not allowed" },
  { tool: "sshToNas", pattern: "rm -rf", action: "deny", reason: "Recursive force delete over SSH is not allowed" },
  { tool: "sshToNas", pattern: "sudo rm", action: "deny", reason: "Sudo delete over SSH is not allowed" },
  { tool: "sshToNas", pattern: "DROP TABLE", action: "deny", reason: "SQL DROP TABLE is not allowed" },
  { tool: "sshToNas", pattern: "DROP DATABASE", action: "deny", reason: "SQL DROP DATABASE is not allowed" },
  { tool: "runShell", pattern: "DROP TABLE", action: "deny", reason: "SQL DROP TABLE is not allowed" },
  { tool: "runShell", pattern: "DROP DATABASE", action: "deny", reason: "SQL DROP DATABASE is not allowed" },
  { tool: "writeFileTool", pattern: "/etc/passwd", action: "deny", reason: "Writing to /etc/passwd is not allowed" },
  { tool: "writeFileTool", pattern: "/etc/shadow", action: "deny", reason: "Writing to /etc/shadow is not allowed" },
];

let _extraRulesLoaded = false;
let _rules: PermissionRule[] = [...DEFAULT_DENY_RULES];

async function loadExtraRules(): Promise<void> {
  if (_extraRulesLoaded) return;
  _extraRulesLoaded = true;
  const permFile = path.join(process.env.HOME!, "max", "permissions.json");
  try {
    const raw = await readFile(permFile, "utf-8");
    const extra: PermissionRule[] = JSON.parse(raw);
    _rules = [...DEFAULT_DENY_RULES, ...extra];
    log("info", `Loaded ${extra.length} extra permission rules from ${permFile}`);
  } catch {
    // File doesn't exist or is invalid — use defaults only
  }
}

export async function checkPermission(
  toolName: string,
  input: unknown
): Promise<{ allowed: boolean; reason?: string }> {
  await loadExtraRules();

  const inputStr = typeof input === "string" ? input : JSON.stringify(input ?? "");

  for (const rule of _rules) {
    if (rule.tool !== toolName && rule.tool !== "*") continue;
    if (rule.pattern) {
      if (!inputStr.includes(rule.pattern)) continue;
    }
    if (rule.action === "deny") {
      const reason = rule.reason ?? `Denied by rule: tool=${rule.tool} pattern=${rule.pattern ?? "*"}`;
      log("warn", `[permissions] DENIED tool=${toolName} reason="${reason}" input=${inputStr.slice(0, 200)}`);
      return { allowed: false, reason };
    }
    if (rule.action === "allow") {
      return { allowed: true };
    }
  }

  return { allowed: true };
}
