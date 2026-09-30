/**
 * @file Every module in the verified tiers must have a test. Ported from big-value.
 *
 * These tiers hold logic with no rendering to reason about: `shared/` is the contract the Rust API, workers
 * and browser agree on, `client/state/` is the store every screen reads, `client/themes/` the palette and
 * pre-paint script, and the `.ts` files under `client/ui/` are pure helpers. A missing test there is a gap, and
 * a gap is invisible once the module is written.
 *
 * A module counts as tested when its mirror exists (`client/state/time.ts` → `tests/client/state/time.test.ts`)
 * or when some test under `tests/` imports it. The second form exists because `tests/shared/contracts.test.ts`
 * covers several small shared contracts in one file.
 *
 * Components (`.tsx` under `client/ui/` and `client/themes/`) are out of scope: they need a renderer, so "no
 * test" is a decision someone makes on purpose, not something this rule should force.
 */
import fs from "node:fs";
import path from "node:path";

import { importedTarget, repoRelative } from "./source-areas.mjs";

/** Tiers where every module is expected to carry a test, and the extensions that count. */
export const MIRRORED_TIERS = [
  { root: "shared", extensions: [".ts", ".tsx"] },
  { root: "client/state", extensions: [".ts", ".tsx"] },
  { root: "client/themes", extensions: [".ts"] },
  { root: "client/ui", extensions: [".ts"] },
];

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** `shared/riftbound.ts` → `tests/shared/riftbound.test.ts`. */
export function mirroredTestPath(sourcePath) {
  const clean = sourcePath.replace(/^\.\//, "").replace(/\.tsx?$/, "");
  return `tests/${clean}.test.ts`;
}

/**
 * The tier a source file belongs to, or null when the file is out of scope. `index.ts` (a registry or barrel)
 * and declaration files are skipped: the catalog test covers the registry.
 */
export function mirroredRootFor(filename, cwd = process.cwd()) {
  const relative = repoRelative(filename, cwd);
  if (!relative || /\.d\.ts$/.test(relative)) return null;
  const extension = path.posix.extname(relative);
  if (extension !== ".ts" && extension !== ".tsx") return null;
  if (/^index\.tsx?$/.test(path.posix.basename(relative))) return null;
  const tier = MIRRORED_TIERS.find((candidate) => relative.startsWith(`${candidate.root}/`) && candidate.extensions.includes(extension));
  return tier?.root ?? null;
}

/** True when the program is only re-exports and imports, so it has no behaviour of its own. */
export function isBarrel(program) {
  const body = program?.body ?? [];
  if (body.length === 0) return false;
  return body.every(
    (node) =>
      node?.type === "ImportDeclaration" ||
      node?.type === "ExportAllDeclaration" ||
      (node?.type === "ExportNamedDeclaration" && Boolean(node.source)),
  );
}

function listTests(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listTests(full, out);
    else if (TEST_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * cwd → { at, imported }. One CLI run lints every file within a few seconds, so a short TTL scans tests/ about
 * once per run while an editor's long-lived ESLint still sees a test written a moment ago.
 */
const importedByTestsCache = new Map();
const CACHE_TTL_MS = 2_000;

/** Module paths, without extension, imported by any test under `tests/`. */
export function modulesImportedByTests(cwd = process.cwd()) {
  const cached = importedByTestsCache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.imported;
  const imported = new Set();
  for (const file of listTests(path.join(cwd, "tests"), [])) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      const target = importedTarget(match[1], path.dirname(file), cwd);
      if (target) imported.add(target.replace(/\.[cm]?[jt]sx?$/, ""));
    }
  }
  importedByTestsCache.set(cwd, { at: Date.now(), imported });
  return imported;
}

/** True when the mirrored test exists, or a test imports the module. */
export function hasTest(relative, cwd = process.cwd()) {
  if (fs.existsSync(path.join(cwd, mirroredTestPath(relative)))) return true;
  return modulesImportedByTests(cwd).has(relative.replace(/\.tsx?$/, ""));
}

/** @type {import('eslint').Rule.RuleModule} */
export const testMirrorRule = {
  meta: {
    type: "problem",
    docs: { description: "Modules in the verified tiers (shared/, client/state/, client/themes/, client/ui/*.ts) must have a test" },
    schema: [],
    messages: {
      missingTest:
        "{{source}} has no test. Add {{expected}}: {{tier}}/ holds pure logic with no rendering to reason about, so a change here should be pinned down by a failing-then-passing test.",
    },
  },

  create(context) {
    const cwd = typeof context.cwd === "string" ? context.cwd : context.getCwd();
    const relative = repoRelative(context.filename, cwd);
    const tier = mirroredRootFor(context.filename, cwd);
    if (!relative || !tier) return {};

    return {
      Program(node) {
        if (isBarrel(node)) return;
        if (hasTest(relative, cwd)) return;
        context.report({
          node,
          messageId: "missingTest",
          data: { source: relative, expected: mirroredTestPath(relative), tier },
        });
      },
    };
  },
};

export default testMirrorRule;
