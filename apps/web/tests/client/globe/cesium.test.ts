import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { cesium, CESIUM_BASE_URL } from "client/globe/cesium";

const GLOBE_DIR = path.join(import.meta.dir, "..", "..", "..", "client", "globe");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [],
  );
}

describe("Cesium loading", () => {
  test("globe modules import Cesium types only; values come from the prebuilt module at runtime", () => {
    const offenders = sources(GLOBE_DIR).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /^import\s+(?!type\b)[^;]*\sfrom\s+["']cesium["']/m.test(text) || /import\(\s*["']cesium["']\s*\)/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  test("no Entity API in the globe (primitives only)", () => {
    const offenders = sources(GLOBE_DIR).filter((file) => /viewer\.entities|new Entity\(|\.entities\.add/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("cesium() is explicit about load order; base URL is /cesium", () => {
    expect(CESIUM_BASE_URL).toBe("/cesium");
    // Other tests in this directory install the npm module; either way the accessor never returns undefined.
    try {
      expect(typeof cesium().CesiumWidget).toBe("function");
    } catch (err) {
      expect(String(err)).toMatch(/not loaded/);
    }
  });
});
