import { describe, it, expect } from "@jest/globals";
import { extractAssistantTextFromTurn, extractErrorFromTurn } from "../src/response.js";

describe("extractAssistantTextFromTurn", () => {
  it("returns assistant text from current turn", () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "old q" }] },
      { role: "assistant", content: [{ type: "text", text: "old a" }] },
      { role: "user", content: [{ type: "text", text: "new q" }] },
      { role: "assistant", content: [{ type: "text", text: "new a" }] },
    ];

    expect(extractAssistantTextFromTurn(messages as any, 2)).toBe("new a");
  });

  it("does not return stale previous-turn assistant text", () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "old q" }] },
      { role: "assistant", content: [{ type: "text", text: "max via mux finally fixed" }] },
      { role: "user", content: [{ type: "text", text: "new q" }] },
      { role: "toolCall", content: [] },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    ];

    expect(extractAssistantTextFromTurn(messages as any, 2)).toBe("");
  });
});

describe("extractErrorFromTurn", () => {
  it("returns errorMessage when assistant message has stopReason error", () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "429 rate_limit_error: too many requests",
      },
    ];
    expect(extractErrorFromTurn(messages, 0)).toBe("429 rate_limit_error: too many requests");
  });

  it("returns null when assistant message completed normally", () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
        stopReason: "stop",
      },
    ];
    expect(extractErrorFromTurn(messages, 0)).toBeNull();
  });

  it("returns null when no assistant messages exist in the turn", () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    expect(extractErrorFromTurn(messages, 0)).toBeNull();
  });

  it("only checks messages from startIndex onwards", () => {
    const messages: any[] = [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "old error from previous turn",
      },
      { role: "user", content: [{ type: "text", text: "retry" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "success" }],
        stopReason: "stop",
      },
    ];
    expect(extractErrorFromTurn(messages, 1)).toBeNull();
  });

  it("returns the most recent error when multiple exist", () => {
    const messages: any[] = [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "first error",
      },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "second error",
      },
    ];
    expect(extractErrorFromTurn(messages, 0)).toBe("second error");
  });

  it("ignores stopReason error when errorMessage is missing", () => {
    const messages: any[] = [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
      },
    ];
    expect(extractErrorFromTurn(messages, 0)).toBeNull();
  });
});
