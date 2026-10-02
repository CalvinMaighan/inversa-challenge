/**
 * Copy `@sqlite.org/sqlite-wasm`'s runtime files into `public/sqlite-wasm/` so the db worker can load the
 * engine as a plain URL module at runtime (see db.worker.ts). Turbopack cannot bundle the package: its
 * amalgamated `index.mjs` spawns `new Worker(new URL(<dynamic>, import.meta.url))` for the async OPFS
 * proxy, which the bundler refuses ("Can't resolve <dynamic>"). Serving the files untouched sidesteps
 * that; the `opfs-sahpool` VFS we use never spawns that worker anyway.
 *
 * Runs before `dev` and `build` (package.json pre-scripts) and from the e2e script.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const SQLITE_WASM_FILES = ["index.mjs", "sqlite3.wasm", "sqlite3-opfs-async-proxy.js", "sqlite3-worker1.mjs"] as const;
export const SQLITE_WASM_PUBLIC_DIR = "sqlite-wasm";

export function copySqliteWasm(appDir = join(import.meta.dir, "..")): { dir: string; copied: number } {
  const entry = Bun.resolveSync("@sqlite.org/sqlite-wasm", appDir);
  const src = dirname(entry);
  const dir = join(appDir, "public", SQLITE_WASM_PUBLIC_DIR);
  mkdirSync(dir, { recursive: true });
  let copied = 0;
  for (const name of SQLITE_WASM_FILES) {
    const from = join(src, name);
    const to = join(dir, name);
    if (existsSync(to) && statSync(to).size === statSync(from).size && statSync(to).mtimeMs >= statSync(from).mtimeMs) continue;
    copyFileSync(from, to);
    copied += 1;
  }
  return { dir, copied };
}

if (import.meta.main) {
  const { dir, copied } = copySqliteWasm();
  console.log(`sqlite-wasm: ${copied} file(s) copied to ${dir}`);
}
