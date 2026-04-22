import { readFileSync, existsSync, statSync } from "fs";
import path from "path";
import ignore, { Ignore } from "ignore";
import { log } from "../logger.js";

/**
 * Loads .contextignore patterns and returns a predicate for whether a given
 * absolute path should be hidden from the agent's own file tools.
 *
 * Lookup: walks up from the requested path looking for the nearest
 * .contextignore, up to the repo root (a directory containing .git or
 * package.json). Results are cached per-root.
 *
 * Disable globally with MAX_IGNORE_CONTEXT=false.
 */

type CacheEntry = { root: string; ig: Ignore };
const cache = new Map<string, CacheEntry>();

function findRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(path.join(dir, ".contextignore"))) return dir;
    if (existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadFor(root: string): Ignore {
  const cached = cache.get(root);
  if (cached) return cached.ig;
  const ig = ignore();
  const ciPath = path.join(root, ".contextignore");
  if (existsSync(ciPath)) {
    try {
      ig.add(readFileSync(ciPath, "utf-8"));
    } catch (e: any) {
      log("warn", `Failed to read ${ciPath}: ${e.message}`);
    }
  }
  cache.set(root, { root, ig });
  return ig;
}

export function isIgnored(absPath: string): boolean {
  if (process.env.MAX_IGNORE_CONTEXT === "false") return false;
  const startDir = path.dirname(path.resolve(absPath));
  const root = findRoot(startDir);
  if (!root) return false;
  const rel = path.relative(root, path.resolve(absPath));
  if (!rel || rel.startsWith("..")) return false;
  const ig = loadFor(root);
  return ig.ignores(rel);
}

export function filterIgnored(baseDir: string, names: string[]): string[] {
  if (process.env.MAX_IGNORE_CONTEXT === "false") return names;
  const root = findRoot(path.resolve(baseDir));
  if (!root) return names;
  const ig = loadFor(root);
  return names.filter((n) => {
    const abs = path.resolve(baseDir, n);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..")) return true;
    // Directory-ending patterns (e.g. `node_modules/`) only match paths with a
    // trailing slash, so probe both forms when the entry is a directory.
    let isDir = false;
    try { isDir = statSync(abs).isDirectory(); } catch {}
    if (isDir && ig.ignores(rel + "/")) return false;
    return !ig.ignores(rel);
  });
}

export function clearIgnoreCache(): void {
  cache.clear();
}
