import { describe, expect, test } from "bun:test";

import { isClientUiFile } from "@/eslint-plugins/inversa/require-use-client.mjs";

import { ids, lint } from "./lint";

const run = (code: string, filename: string) => ids(lint("require-use-client", code, filename));

describe("require-use-client", () => {
  test("scopes to client/ui/", () => {
    const cwd = process.cwd();
    expect(isClientUiFile(`${cwd}/client/ui/AppShell.tsx`, cwd)).toBe(true);
    expect(isClientUiFile(`${cwd}/client/state/time.ts`, cwd)).toBe(false);
    expect(isClientUiFile(`${cwd}/app/page.tsx`, cwd)).toBe(false);
  });

  test("requires the directive as the first statement", () => {
    expect(run("export const A = () => null;", "client/ui/A.tsx")).toEqual(["missingUseClient"]);
    expect(run('import x from "y";\n"use client";\nexport const A = x;', "client/ui/A.tsx")).toEqual(["missingUseClient"]);
    expect(run('"use client";\nexport const A = () => null;', "client/ui/A.tsx")).toEqual([]);
  });

  test("leaves other areas alone", () => {
    expect(run("export const A = () => null;", "app/page.tsx")).toEqual([]);
  });
});
