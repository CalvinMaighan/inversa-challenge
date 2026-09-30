import { afterEach, describe, expect, test } from "bun:test";

import { hasTest, isBarrel, mirroredRootFor, mirroredTestPath } from "@/eslint-plugins/inversa/test-mirror.mjs";

import { cleanScratch, ids, lint, scratch } from "./lint";

afterEach(cleanScratch);

const slice = `import { key } from "@calvinjs/active-state";\nexport const THING = key("THING", { n: 0 });\n`;
const run = (code: string, filename: string, cwd: string) => ids(lint("test-mirror", code, filename, cwd));

describe("mirroredRootFor", () => {
  test("covers shared/, client/state/, client/themes/*.ts and client/ui/*.ts", () => {
    expect(mirroredRootFor("shared/feed-state.ts")).toBe("shared");
    expect(mirroredRootFor("client/state/time.ts")).toBe("client/state");
    expect(mirroredRootFor("client/themes/palette.ts")).toBe("client/themes");
    expect(mirroredRootFor("client/ui/measure.ts")).toBe("client/ui");
  });

  test("skips registries, declarations, components and other areas", () => {
    expect(mirroredRootFor("client/state/index.ts")).toBeNull();
    expect(mirroredRootFor("shared/x.d.ts")).toBeNull();
    expect(mirroredRootFor("client/ui/AppShell.tsx")).toBeNull();
    expect(mirroredRootFor("client/themes/GlobalStyles.tsx")).toBeNull();
    expect(mirroredRootFor("client/globe/viewer.ts")).toBeNull();
    expect(mirroredRootFor("app/page.tsx")).toBeNull();
  });

  test("mirror path", () => {
    expect(mirroredTestPath("client/state/time.ts")).toBe("tests/client/state/time.test.ts");
  });
});

describe("isBarrel", () => {
  test("re-export-only modules are barrels; declarations are not", () => {
    expect(isBarrel({ body: [{ type: "ImportDeclaration" }, { type: "ExportAllDeclaration" }] })).toBe(true);
    expect(isBarrel({ body: [{ type: "ExportNamedDeclaration", declaration: {} }] })).toBe(false);
    expect(isBarrel({ body: [] })).toBe(false);
  });
});

describe("test-mirror", () => {
  test("flags a module with no test and names the mirror to add", () => {
    const cwd = scratch({ "client/state/thing.ts": slice });
    const messages = lint("test-mirror", slice, "client/state/thing.ts", cwd);
    expect(ids(messages)).toEqual(["missingTest"]);
    expect(messages[0]?.message).toContain("tests/client/state/thing.test.ts");
  });

  test("passes once the mirror exists", () => {
    const cwd = scratch({ "client/state/thing.ts": slice, "tests/client/state/thing.test.ts": "export {};\n" });
    expect(run(slice, "client/state/thing.ts", cwd)).toEqual([]);
  });

  test("accepts a test elsewhere that imports the module, through any alias", () => {
    const viaAlias = scratch({ "shared/a.ts": "export const a = 1;\n", "tests/shared/contracts.test.ts": 'import { a } from "shared/a";\n' });
    expect(run("export const a = 1;\n", "shared/a.ts", viaAlias)).toEqual([]);
    const viaAt = scratch({ "shared/b.ts": "export const b = 1;\n", "tests/x.test.ts": 'import { b } from "@/shared/b";\n' });
    expect(hasTest("shared/b.ts", viaAt)).toBe(true);
    const viaRelative = scratch({ "shared/c.ts": "export const c = 1;\n", "tests/shared/c2.test.ts": 'import { c } from "../../shared/c";\n' });
    expect(hasTest("shared/c.ts", viaRelative)).toBe(true);
  });

  test("a test in the wrong mirror directory does not count unless it imports the module", () => {
    const cwd = scratch({ "client/state/thing.ts": slice, "tests/client/thing.test.ts": "export {};\n" });
    expect(run(slice, "client/state/thing.ts", cwd)).toEqual(["missingTest"]);
  });

  test("exempts barrels and out-of-tier files", () => {
    const cwd = scratch({});
    expect(run('export { a } from "./a";\n', "shared/bucket.ts", cwd)).toEqual([]);
    expect(run("export const x = 1;\n", "client/globe/viewer.ts", cwd)).toEqual([]);
  });
});
