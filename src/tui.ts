#!/usr/bin/env node
/**
 * Max TUI — Terminal UI client for Agent Max
 * Connects to the A2A streaming endpoint and renders responses with pi-tui.
 */
import "dotenv/config";
import { TUI, ProcessTerminal, Markdown, Input, Text, Loader, Container } from "@mariozechner/pi-tui";

const PORT = process.env.MAX_PORT || process.env.A2A_PORT || "8770";
const HOST = process.env.MAX_HOST || "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const TOKEN = process.env.A2A_SHARED_SECRET || "";

// Simple ANSI color helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const gray = (s: string) => `\x1b[90m${s}\x1b[39m`;

// Markdown theme matching typical terminal styling
const markdownTheme = {
  heading: (t: string) => bold(cyan(t)),
  link: (t: string) => cyan(t),
  linkUrl: (t: string) => dim(t),
  code: (t: string) => `\x1b[48;5;236m ${t} \x1b[49m`,
  codeBlock: (t: string) => t,
  codeBlockBorder: (t: string) => dim(t),
  quote: (t: string) => dim(t),
  quoteBorder: (t: string) => dim(t),
  hr: (t: string) => dim(t),
  listBullet: (t: string) => cyan(t),
  bold: (t: string) => bold(t),
  italic: (t: string) => `\x1b[3m${t}\x1b[23m`,
  strikethrough: (t: string) => `\x1b[9m${t}\x1b[29m`,
  underline: (t: string) => `\x1b[4m${t}\x1b[24m`,
};

class MaxTUI {
  private tui: TUI;
  private header: Text;
  private responseArea: Container;
  private currentMarkdown: Markdown | null = null;
  private statusText: Text;
  private input: Input;
  private separator: Text;
  private isStreaming = false;
  private responseBuffer = "";
  private toolLog: string[] = [];

  constructor() {
    const terminal = new ProcessTerminal();
    this.tui = new TUI(terminal, true);

    // Header
    this.header = new Text(
      bold(cyan(" Max")) + dim(` · ${HOST}:${PORT}`),
      0, 0,
    );

    // Separator after header
    this.separator = new Text(dim("─".repeat(60)), 0, 0);

    // Response area
    this.responseArea = new Container();

    // Status line (thinking/tool indicators)
    this.statusText = new Text("", 0, 0);

    // Input
    this.input = new Input();
    this.input.onSubmit = (value: string) => {
      if (!value.trim()) return;
      this.input.setValue("");
      this.handleSubmit(value.trim());
    };

    // Layout
    this.tui.addChild(this.header);
    this.tui.addChild(this.separator);
    this.tui.addChild(this.responseArea);
    this.tui.addChild(this.statusText);
    this.tui.addChild(this.input);

    this.tui.setFocus(this.input);

    // Handle Ctrl+C
    this.tui.addInputListener((data: string) => {
      if (data === "\x03") {
        this.shutdown();
        return { consume: true };
      }
      return undefined;
    });
  }

  async start() {
    this.tui.start();
    this.tui.requestRender();

    // Check server health
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
      const res = await fetch(`${BASE_URL}/health`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const health = await res.json() as any;
      this.statusText.setText(dim(` Connected · uptime ${health.uptime}s · ${health.messagesInContext} messages in context`));
    } catch (e: any) {
      this.statusText.setText(yellow(` Could not reach Max at ${BASE_URL} — is the agent running?`));
    }
    this.tui.requestRender();
  }

  private async handleSubmit(text: string) {
    if (this.isStreaming) return;
    this.isStreaming = true;

    // Show user message
    const userMsg = new Text(bold(green(" > ")) + text, 0, 0);
    this.responseArea.addChild(userMsg);
    this.responseArea.addChild(new Text("", 0, 0)); // spacer

    // Reset state
    this.responseBuffer = "";
    this.toolLog = [];
    this.currentMarkdown = new Markdown("", 1, 0, markdownTheme);
    this.responseArea.addChild(this.currentMarkdown);

    this.statusText.setText(dim(" Thinking..."));
    this.tui.requestRender();

    try {
      await this.streamRequest(text);
    } catch (e: any) {
      this.statusText.setText(yellow(` Error: ${e.message}`));
    }

    this.isStreaming = false;
    this.statusText.setText("");
    // Add spacer after response
    this.responseArea.addChild(new Text("", 0, 0));
    this.tui.requestRender();
  }

  private async streamRequest(text: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;

    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/sendStream",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text }],
        },
      },
    };

    const res = await fetch(`${BASE_URL}/tasks/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}: ${await res.text()}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // keep incomplete line

      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7);
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            this.handleSSEEvent(eventType, parsed);
          } catch {
            // malformed JSON, skip
          }
        }
        // empty line = end of event (already handled by split)
      }
    }
  }

  private handleSSEEvent(type: string, data: any) {
    switch (type) {
      case "text_delta":
        this.responseBuffer += data.delta;
        if (this.currentMarkdown) {
          this.currentMarkdown.setText(this.responseBuffer);
        }
        this.statusText.setText("");
        this.tui.requestRender();
        break;

      case "tool_start": {
        const label = this.toolLabel(data.toolName);
        this.toolLog.push(label);
        this.statusText.setText(dim(` ${this.toolLog.map(t => `[${t}]`).join(" ")} ...`));
        this.tui.requestRender();
        break;
      }

      case "tool_end": {
        const label = this.toolLabel(data.toolName);
        const idx = this.toolLog.indexOf(label);
        if (idx >= 0) this.toolLog.splice(idx, 1);
        const status = this.toolLog.length > 0
          ? dim(` ${this.toolLog.map(t => `[${t}]`).join(" ")} ...`)
          : dim(" Thinking...");
        this.statusText.setText(status);
        this.tui.requestRender();
        break;
      }

      case "task_end":
        this.statusText.setText("");
        this.tui.requestRender();
        break;

      case "error":
        this.statusText.setText(yellow(` Error: ${data.message}`));
        this.tui.requestRender();
        break;
    }
  }

  private toolLabel(name: string): string {
    const labels: Record<string, string> = {
      browser_control: "Browser",
      run_shell: "Shell",
      read_file: "Read",
      write_file: "Write",
      list_files: "Files",
      ssh_to_nas: "SSH",
      delegate_to_nix: "Nix",
      linkedin_search: "LinkedIn",
      linkedin_results: "LinkedIn",
      gpu_wake: "GPU Wake",
      gpu_shutdown: "GPU Off",
      gpu_status: "GPU",
      ios_build: "Xcode",
      ios_install: "iOS",
      ios_build_and_deploy: "iOS Deploy",
      ios_list_devices: "Devices",
      context_info: "Context",
    };
    return labels[name] || name;
  }

  private shutdown() {
    this.tui.stop();
    process.exit(0);
  }
}

async function main() {
  const tui = new MaxTUI();
  await tui.start();
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
