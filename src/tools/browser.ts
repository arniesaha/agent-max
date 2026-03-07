import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// Port 18800: OpenClaw profile (LinkedIn, DoorDash automation)
// Port 9222: Chrome Debug profile (general browsing)
const DEFAULT_CDP_PORT = 9222;

interface CdpTab {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

async function getTabs(port: number): Promise<CdpTab[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  return res.json();
}

async function cdpCommand(wsUrl: string, method: string, params: Record<string, any> = {}, timeout = 15000): Promise<any> {
  // Use dynamic import for WebSocket
  const { WebSocket } = await import("ws");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const msgId = Math.floor(Math.random() * 100000);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP command ${method} timed out`));
    }, timeout);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === msgId) {
        clearTimeout(timer);
        ws.close();
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          resolve(msg.result);
        }
      }
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Navigate to a URL and wait for the page to finish loading via CDP events.
 * Falls back to a fixed delay if the load event doesn't fire within timeout.
 */
async function navigateAndWait(wsUrl: string, url: string, timeout = 30000): Promise<void> {
  const { WebSocket } = await import("ws");

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const navId = Math.floor(Math.random() * 100000);
    const enableId = navId + 1;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        resolve(); // resolve anyway — page may be partially loaded
      }
    }, timeout);

    ws.on("open", () => {
      // Enable Page events so we get loadEventFired
      ws.send(JSON.stringify({ id: enableId, method: "Page.enable" }));
      ws.send(JSON.stringify({ id: navId, method: "Page.navigate", params: { url } }));
    });

    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      // Navigation error (e.g. net::ERR_NAME_NOT_RESOLVED)
      if (msg.id === navId && msg.result?.errorText) {
        clearTimeout(timer);
        settled = true;
        ws.close();
        reject(new Error(`Navigation failed: ${msg.result.errorText}`));
        return;
      }

      // Page finished loading
      if (msg.method === "Page.loadEventFired" && !settled) {
        // Give JS a moment to hydrate after load
        setTimeout(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            ws.close();
            resolve();
          }
        }, 1500);
      }
    });

    ws.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

const SCRAPE_JS = `
(() => {
  // Remove script, style, nav, footer, hidden elements
  const remove = document.querySelectorAll('script, style, noscript, nav, footer, header, [aria-hidden="true"], [style*="display:none"], [style*="display: none"]');
  remove.forEach(el => el.remove());

  const title = document.title || '';
  const meta = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

  // Get visible text content, collapse whitespace
  const body = document.body?.innerText || '';
  const lines = body.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
  const text = lines.join('\\n');

  // Truncate to ~12k chars to stay within tool result limits
  const maxLen = 12000;
  const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\\n...(truncated)' : text;

  return 'Title: ' + title + '\\n' + (meta ? 'Description: ' + meta + '\\n' : '') + '\\n' + truncated;
})()
`;

export const browserControl: AgentTool = {
  name: "browser_control",
  label: "Browser Control",
  description: "Control Chrome via CDP. Actions: list_tabs, navigate, scrape (navigate to URL and extract page text — best for summarizing web pages), evaluate (run JS), screenshot. Port 9222 for debug profile, port 18800 for automation.",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("list_tabs"),
      Type.Literal("navigate"),
      Type.Literal("scrape"),
      Type.Literal("evaluate"),
      Type.Literal("screenshot"),
    ], { description: "Action to perform" }),
    port: Type.Optional(Type.Number({ description: "CDP port. 9222 for debug, 18800 for automation. Default: 9222" })),
    url: Type.Optional(Type.String({ description: "URL to navigate to (for navigate/scrape action)" })),
    expression: Type.Optional(Type.String({ description: "JavaScript expression to evaluate (for evaluate action)" })),
    tab_index: Type.Optional(Type.Number({ description: "Tab index to target (default: 0)" })),
  }),
  execute: async (_id, params: any) => {
    const { action, url, expression, tab_index } = params;
    const port = params.port || DEFAULT_CDP_PORT;

    try {
      switch (action) {
        case "list_tabs": {
          const tabs = await getTabs(port);
          const summary = tabs
            .filter(t => t.type === "page")
            .map((t, i) => `[${i}] ${t.title} — ${t.url}`)
            .join("\n");
          return { content: [{ type: "text", text: summary || "No pages open" }], details: { count: tabs.length } };
        }

        case "navigate": {
          if (!url) return { content: [{ type: "text", text: "No URL provided" }], details: { error: "missing url" } };
          const tabs = await getTabs(port);
          const pages = tabs.filter(t => t.type === "page");
          const tab = pages[tab_index || 0];
          if (!tab) return { content: [{ type: "text", text: "No browser tab available" }], details: { error: "no tabs" } };

          await navigateAndWait(tab.webSocketDebuggerUrl, url);
          return { content: [{ type: "text", text: `Navigated to ${url}` }], details: { url } };
        }

        case "scrape": {
          if (!url) return { content: [{ type: "text", text: "No URL provided" }], details: { error: "missing url" } };
          const tabs = await getTabs(port);
          const pages = tabs.filter(t => t.type === "page");
          const tab = pages[tab_index || 0];
          if (!tab) return { content: [{ type: "text", text: "No browser tab available. Is Chrome running with --remote-debugging-port?" }], details: { error: "no tabs" } };

          // Navigate and wait for load
          await navigateAndWait(tab.webSocketDebuggerUrl, url);

          // Extract text content
          const result = await cdpCommand(tab.webSocketDebuggerUrl, "Runtime.evaluate", {
            expression: SCRAPE_JS,
            returnByValue: true,
          }, 15000);

          const text = result?.result?.value;
          if (!text) {
            return { content: [{ type: "text", text: `Navigated to ${url} but could not extract text content. The page may require JavaScript rendering or authentication.` }], details: { url, error: "empty" } };
          }

          return { content: [{ type: "text", text }], details: { url, length: text.length } };
        }

        case "evaluate": {
          if (!expression) return { content: [{ type: "text", text: "No expression provided" }], details: { error: "missing expression" } };
          const tabs = await getTabs(port);
          const pages = tabs.filter(t => t.type === "page");
          const tab = pages[tab_index || 0];
          if (!tab) return { content: [{ type: "text", text: "No browser tab available" }], details: { error: "no tabs" } };

          const result = await cdpCommand(tab.webSocketDebuggerUrl, "Runtime.evaluate", {
            expression,
            returnByValue: true,
          });
          const value = result?.result?.value;
          const text = value !== undefined ? (typeof value === "string" ? value : JSON.stringify(value, null, 2)) : "(undefined)";
          return { content: [{ type: "text", text }], details: { type: result?.result?.type, value } };
        }

        case "screenshot": {
          const tabs = await getTabs(port);
          const pages = tabs.filter(t => t.type === "page");
          const tab = pages[tab_index || 0];
          if (!tab) return { content: [{ type: "text", text: "No browser tab available" }], details: { error: "no tabs" } };

          const result = await cdpCommand(tab.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" }, 30000);
          if (result?.data) {
            // Save screenshot to file
            const { writeFile } = await import("fs/promises");
            const path = await import("path");
            const filename = `screenshot-${Date.now()}.png`;
            const filepath = path.join(process.env.HOME!, "max", "data", filename);
            await writeFile(filepath, Buffer.from(result.data, "base64"));
            return {
              content: [
                { type: "text", text: `Screenshot saved to ${filepath}` },
                { type: "image", data: result.data, mimeType: "image/png" },
              ],
              details: { path: filepath },
            };
          }
          return { content: [{ type: "text", text: "Failed to capture screenshot" }], details: { error: "no data" } };
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: { error: "unknown" } };
      }
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Browser error: ${e.message}. Is Chrome running with --remote-debugging-port=${port}?` }],
        details: { error: e.message },
      };
    }
  },
};
