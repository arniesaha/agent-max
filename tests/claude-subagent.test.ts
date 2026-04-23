import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  _buildAnthropicCustomHeadersForTest,
  _clearJobsForTest,
  truncateOutput,
  evictOldJobs,
  MAX_OUTPUT_CHARS,
  delegateToClaudeSubagent,
} from "../src/tools/claude-subagent.js";

// Reset in-memory state before each test
beforeEach(() => {
  _clearJobsForTest();
});

// ─── Header attribution ───────────────────────────────────────────────────────

describe("AgentWeave header attribution", () => {
  it("includes all required session attribution headers", () => {
    const headers = _buildAnthropicCustomHeadersForTest({
      childSessionId: "child-123",
      parentSessionId: "parent-456",
      agentId: "max-v1",
      taskLabel: "test-task",
      proxyToken: "token-abc",
    });

    expect(headers).toContain("X-AgentWeave-Session-Id: child-123");
    expect(headers).toContain("X-AgentWeave-Parent-Session-Id: parent-456");
    expect(headers).toContain("X-AgentWeave-Agent-Id: max-v1");
    expect(headers).toContain("X-AgentWeave-Agent-Type: subagent");
    expect(headers).toContain("X-AgentWeave-Task-Label: test-task");
    expect(headers).toContain("X-AgentWeave-Proxy-Token: token-abc");
  });

  it("omits proxy token header when token not provided", () => {
    const headers = _buildAnthropicCustomHeadersForTest({
      childSessionId: "child-1",
      parentSessionId: "parent-1",
      agentId: "max-v1",
      taskLabel: "no-token",
    });

    expect(headers).not.toContain("X-AgentWeave-Proxy-Token");
  });

  it("formats headers as newline-separated key: value pairs", () => {
    const headers = _buildAnthropicCustomHeadersForTest({
      childSessionId: "c",
      parentSessionId: "p",
      agentId: "a",
      taskLabel: "t",
    });
    const lines = headers.split("\n");
    for (const line of lines) {
      expect(line).toMatch(/^[\w-]+: .+$/);
    }
  });
});

// ─── Output truncation ────────────────────────────────────────────────────────

describe("output truncation", () => {
  it("returns text unchanged when within limit", () => {
    const text = "hello world";
    expect(truncateOutput(text)).toBe(text);
  });

  it("returns text unchanged at exactly the limit", () => {
    const text = "x".repeat(MAX_OUTPUT_CHARS);
    expect(truncateOutput(text)).toBe(text);
  });

  it("keeps head and tail, drops the middle, when over limit", () => {
    const head = "HEAD".repeat(3000);    // 12000 chars — start of output
    const middle = "MID".repeat(4000);   // 12000 chars — will be dropped
    const tail = "TAIL".repeat(1000);    // 4000 chars — end of output
    const combined = head + middle + tail;
    expect(combined.length).toBeGreaterThan(MAX_OUTPUT_CHARS);

    const result = truncateOutput(combined);
    // Head+tail split (default 70/30) keeps ~10500 head + 4500 tail from budget 15000
    expect(result.startsWith(head.slice(0, 1000))).toBe(true);
    expect(result.endsWith(tail)).toBe(true);
    expect(result).toContain("[truncated");
    expect(result).not.toContain(middle);
  });
});

// ─── Job eviction ─────────────────────────────────────────────────────────────

describe("job eviction", () => {
  it("does not evict when under the cap", () => {
    // Just verify evictOldJobs doesn't throw on empty map
    expect(() => evictOldJobs()).not.toThrow();
  });
});

// ─── Tool action validation ───────────────────────────────────────────────────

describe("delegate_to_claude_subagent tool", () => {
  const tool = delegateToClaudeSubagent;

  describe("action=start", () => {
    it("returns error when prompt is missing", async () => {
      const result = await tool.execute("test", { action: "start", prompt: "" });
      expect((result.content[0] as any).text).toContain("Missing required field: prompt");
      expect(result.details.success).toBe(false);
    });

    it("returns error when prompt is whitespace only", async () => {
      const result = await tool.execute("test", { action: "start", prompt: "   " });
      expect((result.content[0] as any).text).toContain("Missing required field: prompt");
      expect(result.details.success).toBe(false);
    });
  });

  describe("action=status", () => {
    it("returns error when job_id is missing", async () => {
      const result = await tool.execute("test", { action: "status", job_id: "" });
      expect((result.content[0] as any).text).toContain("Missing required field: job_id");
      expect(result.details.success).toBe(false);
    });

    it("returns error for unknown job_id", async () => {
      const result = await tool.execute("test", { action: "status", job_id: "nonexistent-uuid" });
      expect((result.content[0] as any).text).toContain("Unknown job_id");
      expect(result.details.success).toBe(false);
    });
  });

  describe("action=list", () => {
    it("returns empty message when no jobs exist", async () => {
      const result = await tool.execute("test", { action: "list" });
      expect((result.content[0] as any).text).toBe("No claude subagent jobs yet.");
      expect(result.details.success).toBe(true);
      expect(result.details.count).toBe(0);
    });
  });

  describe("invalid action", () => {
    it("returns error for unrecognised action", async () => {
      const result = await tool.execute("test", { action: "nuke" });
      expect((result.content[0] as any).text).toContain("Invalid action");
      expect((result.content[0] as any).text).toContain("start, status, or list");
      expect(result.details.success).toBe(false);
    });

    it("returns error for empty action string", async () => {
      const result = await tool.execute("test", { action: "" });
      expect((result.content[0] as any).text).toContain("Invalid action");
      expect(result.details.success).toBe(false);
    });
  });
});
