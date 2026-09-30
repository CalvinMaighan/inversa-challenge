/**
 * Copies CesiumJS's static runtime (Workers, Assets, Widgets, ThirdParty) and its prebuilt ES module
 * (`index.js`, which the globe imports natively; see client/globe/cesium.ts) from the installed `cesium`
 * package to `public/cesium`, which `CESIUM_BASE_URL = "/cesium"` points at. Same-origin, so everything loads
 * under COEP `require-corp` without CORP headers. Runs before `dev` and `build`; skips the copy when the stamp
 * already matches the installed version. The copy is gitignored.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const DIRS = ["Workers", "Assets", "Widgets", "ThirdParty"] as const;
const FILES = ["index.js"] as const;

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("cesium/package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
const source = path.join(path.dirname(pkgPath), "Build", "Cesium");
const target = path.join(import.meta.dirname, "..", "public", "cesium");
const stamp = path.join(target, "VERSION");

const force = process.argv.includes("--force");
const current = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : null;
const entries = [...DIRS, ...FILES];
const complete = entries.every((name) => existsSync(path.join(target, name)));

if (!force && current === version && complete) {
  console.log(`cesium:copy: public/cesium already at ${version}`);
} else {
  for (const name of entries) {
    const from = path.join(source, name);
    if (!existsSync(from)) throw new Error(`cesium:copy: ${from} is missing; is cesium installed?`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of entries) cpSync(path.join(source, name), path.join(target, name), { recursive: true });
  writeFileSync(stamp, `${version}\n`);
  console.log(`cesium:copy: copied ${entries.join(", ")} from cesium ${version} to public/cesium`);
}
