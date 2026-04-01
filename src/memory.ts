import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { loadActiveTodos } from "./tools/todo.js";

const MAX_HOME = path.join(process.env.HOME!, "max");
const MEMORY_DIR = path.join(MAX_HOME, "memory");

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function subDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() - n);
  return result;
}

async function readFileSafe(p: string): Promise<string> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

export async function loadMemory(): Promise<string> {
  const today = formatDate(new Date());
  const yesterday = formatDate(subDays(new Date(), 1));

  const soul = await readFileSafe(path.join(MAX_HOME, "SOUL.md"));
  const longTermMem = await readFileSafe(path.join(MAX_HOME, "MEMORY.md"));
  const yesterdayMem = await readFileSafe(path.join(MEMORY_DIR, `${yesterday}.md`));
  const todayMem = await readFileSafe(path.join(MEMORY_DIR, `${today}.md`));

  const formatting = `## Response Formatting

You communicate via Telegram. Your responses are rendered with rich formatting. Use it naturally:

- **Bold** for emphasis, key terms, names, statuses
- *Italic* for asides, subtle emphasis, file paths
- \`inline code\` for commands, function names, values
- \`\`\`code blocks\`\`\` for multi-line code or logs
- Bullet lists for multiple items
- Emojis where they add clarity: ✅ ❌ ⚠️ 📁 🔧 🚀 💡 etc.
- > Blockquotes for quoting text or highlighting key info

Keep responses concise but visually scannable. Use formatting to create structure, not walls of plain text.`;

  // Append active todos to system prompt
  const activeTodos = await loadActiveTodos();
  let todoSection = "";
  if (activeTodos.length > 0) {
    const lines = activeTodos.map((t) => `- [${t.status}] ${t.task}`);
    todoSection = `## Active Tasks\n${lines.join("\n")}`;
  }

  return [soul, longTermMem, formatting, yesterdayMem, todayMem, todoSection].filter(Boolean).join("\n\n---\n\n");
}

export async function writeMemoryEvent(event: string): Promise<void> {
  const today = formatDate(new Date());
  const filePath = path.join(MEMORY_DIR, `${today}.md`);
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });

  if (!existsSync(MEMORY_DIR)) {
    await mkdir(MEMORY_DIR, { recursive: true });
  }

  const existing = await readFileSafe(filePath);
  const header = existing ? "" : `# ${today}\n\n`;
  const entry = `${header}${existing ? "\n" : ""}- **${time}** — ${event}\n`;

  await writeFile(filePath, existing + entry, "utf-8");
}
