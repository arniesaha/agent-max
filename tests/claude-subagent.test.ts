import { describe, it, expect } from "@jest/globals";
import { _buildAnthropicCustomHeadersForTest } from "../src/tools/claude-subagent.js";

describe("delegate_to_claude_subagent header attribution", () => {
  it("includes required AgentWeave session attribution headers", () => {
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
});
