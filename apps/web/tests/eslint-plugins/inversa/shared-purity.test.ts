import { describe, expect, test } from "bun:test";

import { impurity } from "@/eslint-plugins/inversa/shared-purity.mjs";

import { ids, lint } from "./lint";

const run = (code: string, filename = "shared/thing.ts") => ids(lint("shared-purity", code, filename));

describe("shared-purity", () => {
  test("classifies runtime imports", () => {
    expect(impurity("node:fs")).toBe("Node.js built-in");
    expect(impurity("path")).toBe("Node.js built-in");
    expect(impurity("react")).toBe("React runtime");
    expect(impurity("next/navigation")).toBe("Next.js runtime");
    expect(impurity("server-only")).toBe("server-only marker");
    expect(impurity("zod")).toBeNull();
  });

  test("rejects runtime imports and globals in shared/", () => {
    expect(run('import fs from "node:fs";')).toEqual(["impureSharedImport"]);
    expect(run('export { useState } from "react";')).toEqual(["impureSharedImport"]);
    expect(run("export const w = () => window.innerWidth;")).toEqual(["impureSharedGlobal"]);
    expect(run("export const env = process.env.X;")).toEqual(["impureSharedGlobal"]);
  });

  test("allows pure code, property names and shadowed locals", () => {
    expect(run('import { z } from "zod";\nexport const s = z.string();')).toEqual([]);
    expect(run("export const o = { window: 1, document: 2 };\nexport type T = { process: string };")).toEqual([]);
    expect(run("export function f(window: number) { return window; }")).toEqual([]);
  });

  test("only applies under shared/", () => {
    expect(run('import fs from "node:fs";', "server/agent/x.ts")).toEqual([]);
    expect(run("export const w = window;", "client/x.ts")).toEqual([]);
  });

  test("covers nested shared/ modules", () => {
    expect(run('import React from "react";', "shared/voice/protocol.ts")).toEqual(["impureSharedImport"]);
  });
});
