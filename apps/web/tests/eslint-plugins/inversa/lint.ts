import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import tsParser from "@typescript-eslint/parser";
import { Linter, type ESLint } from "eslint";

import inversaPlugin from "@/eslint-plugins/inversa/plugin.mjs";

/**
 * Lint `code` as if it lived at `filename` (app-relative) with one inversa rule enabled. Same TypeScript
 * parser as the real config, so `import type` and TSX fixtures behave as they do in `eslint .`.
 */
export function lint(ruleName: string, code: string, filename: string, cwd: string = process.cwd()) {
  return new Linter({ configType: "flat", cwd }).verify(
    code,
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parser: tsParser,
        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { inversa: inversaPlugin as ESLint.Plugin },
      rules: { [`inversa/${ruleName}`]: "error" },
    },
    { filename: path.join(cwd, filename) },
  );
}

/** Message ids only, which is all most assertions need. */
export const ids = (messages: { messageId?: string }[]) => messages.map((m) => m.messageId);

const scratchDirs: string[] = [];

/** A throwaway app tree, so filesystem-reading rules are tested against known files, not the real app. */
export function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "inversa-eslint-"));
  scratchDirs.push(dir);
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(dir, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

export function cleanScratch() {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
}
