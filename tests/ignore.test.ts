import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { isIgnored, filterIgnored, clearIgnoreCache } from "../src/tools/ignore.js";

describe("contextignore enforcement", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "ctxignore-"));
    // Stand up a fake repo root with a package.json anchor.
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(
      path.join(root, ".contextignore"),
      "node_modules/\n*.png\ndist/\n"
    );
    mkdirSync(path.join(root, "node_modules", "foo"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "foo", "index.js"), "x");
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "src.ts"), "ok");
    writeFileSync(path.join(root, "image.png"), "binary");
    clearIgnoreCache();
    delete process.env.MAX_IGNORE_CONTEXT;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearIgnoreCache();
  });

  it("matches ignored files", () => {
    expect(isIgnored(path.join(root, "node_modules", "foo", "index.js"))).toBe(true);
    expect(isIgnored(path.join(root, "image.png"))).toBe(true);
    expect(isIgnored(path.join(root, "src.ts"))).toBe(false);
  });

  it("filters directory entries", () => {
    const entries = ["src.ts", "image.png", "node_modules", "dist"];
    expect(filterIgnored(root, entries)).toEqual(["src.ts"]);
  });

  it("honors MAX_IGNORE_CONTEXT=false", () => {
    process.env.MAX_IGNORE_CONTEXT = "false";
    try {
      expect(isIgnored(path.join(root, "image.png"))).toBe(false);
      expect(filterIgnored(root, ["image.png", "src.ts"])).toEqual(["image.png", "src.ts"]);
    } finally {
      delete process.env.MAX_IGNORE_CONTEXT;
    }
  });

  it("returns false when no .contextignore is found", () => {
    const orphanRoot = mkdtempSync(path.join(tmpdir(), "ctxignore-orphan-"));
    try {
      writeFileSync(path.join(orphanRoot, "package.json"), "{}");
      writeFileSync(path.join(orphanRoot, "whatever.png"), "x");
      clearIgnoreCache();
      expect(isIgnored(path.join(orphanRoot, "whatever.png"))).toBe(false);
    } finally {
      rmSync(orphanRoot, { recursive: true, force: true });
    }
  });
});
