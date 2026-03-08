import "dotenv/config";
import { createAgent } from "./agent.js";
import { createTelegramBot } from "./telegram-bot.js";
import { startA2AServer } from "./a2a-server.js";
import { getDb, getIncompleteTasks, updateTaskStatus } from "./task-journal.js";
import { writeMemoryEvent } from "./memory.js";
import { log } from "./logger.js";

async function main() {
  log("info", "Max agent starting up...");

  // Initialize SQLite
  getDb();
  log("info", "Task journal initialized");

  // Recover incomplete tasks from previous run
  const incomplete = getIncompleteTasks();
  if (incomplete.length > 0) {
    log("warn", `Found ${incomplete.length} incomplete tasks from previous run`);
    for (const task of incomplete) {
      if (task.retry_count >= 3) {
        updateTaskStatus(task.id, "failed", { reason: "Max retry exceeded after restart" });
        log("warn", `Task ${task.id} marked failed (max retries)`);
      } else {
        updateTaskStatus(task.id, "failed", { reason: "Agent restarted" });
        log("info", `Task ${task.id} marked failed (agent restart)`);
      }
    }
  }

  // Create agent
  const agent = await createAgent();

  // Start A2A server
  startA2AServer(agent);

  // Start Telegram bot
  const bot = createTelegramBot(agent);
  bot.start({
    onStart: () => {
      log("info", "Telegram bot started");
    },
  });

  await writeMemoryEvent("Max agent started (pi-mono)");
  log("info", "All systems online");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log("info", `Received ${signal}, shutting down...`);
    await writeMemoryEvent(`Max agent shutting down (${signal})`);
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => log("error", `Uncaught exception: ${e.message}`, { stack: e.stack }));
  process.on("unhandledRejection", (e: any) => log("error", `Unhandled rejection: ${e?.message || e}`, { stack: e?.stack }));
}

main().catch((e) => {
  log("error", `Fatal error: ${e.message}`, { stack: e.stack });
  process.exit(1);
});
