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

  it("truncates to the last MAX_OUTPUT_CHARS characters when over limit", () => {
    // prefix is longer than MAX_OUTPUT_CHARS — entirely dropped by truncation
    const prefix = "OLD".repeat(6000);   // 18000 chars — older output, should be cut
    const tail = "NEW".repeat(2000);     // 6000 chars — recent output, should be kept
    const combined = prefix + tail;
    expect(combined.length).toBeGreaterThan(MAX_OUTPUT_CHARS);

    const result = truncateOutput(combined);
    expect(result.length).toBe(MAX_OUTPUT_CHARS);
    // The tail must be fully present at the end of the result
    expect(result.endsWith(tail)).toBe(true);
    // The very start of the result should not be the beginning of prefix
    expect(result).not.toBe(combined);
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
