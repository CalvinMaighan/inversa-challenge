/**
 * D1 G6: every `bun run <name>` and `cargo` command written in README.md, docs/demo-script.md and
 * docs/HUMAN_STEPS.md exists.
 *
 *   bun scripts/check-doc-commands.ts
 *
 * Scans fenced code blocks and inline code spans. `bun run <name>` must be a root package.json script;
 * `bun run --cwd <dir> <name>` a script of `<dir>/package.json`; `bun run <file>.ts` an existing file.
 * A `cargo` command must name an existing `--manifest-path` (or run where `api/Cargo.toml` exists) and, for
 * `cargo run … -- <subcommand>`, a subcommand the API binary parses. Last line:
 * `DOC-COMMANDS checked=<n> missing=<n>`; exit 1 when anything is missing.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const DOCS = ["README.md", "docs/demo-script.md", "docs/HUMAN_STEPS.md"];

const scriptsOf = (dir: string): Set<string> => {
  const file = path.join(ROOT, dir, "package.json");
  if (!existsSync(file)) return new Set();
  return new Set(Object.keys((JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}));
};

/** Subcommands `api/src/main.rs` dispatches on (the first CLI argument). */
const API_MAIN = readFileSync(path.join(ROOT, "api/src/main.rs"), "utf8");
const apiHasSubcommand = (name: string) => API_MAIN.includes(`"${name}"`);

/**
 * Code a doc shows: fenced blocks line by line, then inline spans. Chained commands are split; a `cd <dir>`
 * earlier in the chain becomes `--cwd <dir>` of the bun commands after it.
 */
function commands(text: string): string[] {
  const out: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) out.push(...m[1]!.split("\n"));
  const prose = text.replace(fence, "");
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) out.push(m[1]!);
  return out.flatMap((line) => {
    let cwd = "";
    const cmds: string[] = [];
    for (const part of line.replace(/\s#.*$/, "").trim().split(/\s*(?:&&|\|\||;)\s*/)) {
      const cmd = part.replace(/^(\w+=\S+\s+)+/, "").replace(/^doppler run .*? -- /, "").trim();
      const cd = cmd.match(/^cd\s+(\S+)$/);
      if (cd) cwd = cd[1]!;
      else if (/^cargo /.test(cmd)) cmds.push(cmd);
      else if (/^bun run /.test(cmd)) cmds.push(cwd && !cmd.includes("--cwd") ? cmd.replace(/^bun run /, `bun run --cwd ${cwd} `) : cmd);
    }
    return cmds;
  });
}

const root = scriptsOf(".");
let checked = 0;
const missing: string[] = [];

for (const doc of DOCS) {
  const file = path.join(ROOT, doc);
  if (!existsSync(file)) {
    missing.push(`${doc}: file missing`);
    continue;
  }
  for (const cmd of commands(readFileSync(file, "utf8"))) {
    checked++;
    const words = cmd.split(/\s+/);
    if (words[0] === "bun") {
      let dir = ".";
      let i = 2;
      if (words[i] === "--cwd") {
        dir = words[i + 1]!;
        i += 2;
      }
      if (words[i] === "--filter") i += 2;
      const name = words[i];
      if (!name || name.startsWith("<")) continue;
      if (name.endsWith(".ts")) {
        if (!existsSync(path.join(ROOT, dir, name))) missing.push(`${doc}: \`${cmd}\`: no file ${path.join(dir, name)}`);
        continue;
      }
      const scripts = dir === "." ? root : scriptsOf(dir);
      if (!scripts.has(name)) missing.push(`${doc}: \`${cmd}\`: no script "${name}" in ${path.join(dir, "package.json")}`);
    } else {
      const mi = words.indexOf("--manifest-path");
      const manifest = mi >= 0 ? words[mi + 1]! : "api/Cargo.toml";
      if (!existsSync(path.join(ROOT, manifest))) missing.push(`${doc}: \`${cmd}\`: no manifest ${manifest}`);
      const dash = words.indexOf("--");
      if (words[1] === "run" && dash >= 0 && words[dash + 1] && !words[dash + 1]!.startsWith("-") && !apiHasSubcommand(words[dash + 1]!)) {
        missing.push(`${doc}: \`${cmd}\`: the API binary has no subcommand "${words[dash + 1]}"`);
      }
    }
  }
}

for (const m of missing) console.log(`MISSING ${m}`);
console.log(`DOC-COMMANDS checked=${checked} missing=${missing.length}`);
if (checked === 0 || missing.length) process.exit(1);
