import { describe, it, expect } from "@jest/globals";
import { formatDuration, summarizeResult } from "../src/telegram-notify.js";

describe("formatDuration", () => {
  it("returns 0s for 0ms", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("returns seconds for < 60s", () => {
    expect(formatDuration(30000)).toBe("30s");
    // 59999ms rounds to 60s which crosses the minute threshold → "1m"
    expect(formatDuration(59999)).toBe("1m");
    expect(formatDuration(1000)).toBe("1s");
  });

  it("returns m + s for < 1h", () => {
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(3599000)).toBe("59m 59s");
  });

  it("returns h + m for >= 1h", () => {
    expect(formatDuration(3661000)).toBe("1h 1m");
    expect(formatDuration(7200000)).toBe("2h");
    expect(formatDuration(7500000)).toBe("2h 5m");
  });
});

describe("summarizeResult", () => {
  it("passes through short strings unchanged", () => {
    expect(summarizeResult("hello")).toBe("hello");
    expect(summarizeResult("")).toBe("");
  });

  it("passes through exactly 200 chars unchanged", () => {
    const s = "a".repeat(200);
    expect(summarizeResult(s)).toBe(s);
    expect(summarizeResult(s).length).toBe(200);
  });

  it("truncates strings over 200 chars with ellipsis", () => {
    const s = "a".repeat(201);
    const result = summarizeResult(s);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBe(201); // 200 chars + "…"
  });

  it("respects custom maxChars", () => {
    const s = "abcdefghij"; // 10 chars
    expect(summarizeResult(s, 5)).toBe("abcde…");
    expect(summarizeResult(s, 10)).toBe(s);
    expect(summarizeResult(s, 11)).toBe(s);
  });
});
