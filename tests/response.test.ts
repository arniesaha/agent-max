import { describe, it, expect } from "@jest/globals";
import { extractAssistantTextFromTurn } from "../src/response.js";

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
