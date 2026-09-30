import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { ownsStateKeys, registeredStateKeys } from "@/eslint-plugins/inversa/state-key-registration.mjs";

import { cleanScratch, ids, lint, scratch } from "./lint";

afterEach(cleanScratch);

const registry = `import { catalog } from "@calvinjs/active-state";\nexport const state = catalog(TIME, VIEW);\n`;

describe("state-key-registration", () => {
  test("scopes to state slices, not the registry itself", () => {
    const cwd = process.cwd();
    expect(ownsStateKeys(path.join(cwd, "client/state/time.ts"), cwd)).toBe(true);
    expect(ownsStateKeys(path.join(cwd, "client/state/index.ts"), cwd)).toBe(false);
    expect(ownsStateKeys(path.join(cwd, "client/hud/Top.tsx"), cwd)).toBe(false);
  });

  test("reads the catalog(...) list", () => {
    expect([...(registeredStateKeys(scratch({ "client/state/index.ts": registry })) ?? [])]).toEqual(["TIME", "VIEW"]);
    expect(registeredStateKeys(scratch({}))).toBeNull();
  });

  test("accepts registered keys and rejects the rest", () => {
    const cwd = scratch({ "client/state/index.ts": registry });
    const slice = (name: string) => `import { key } from "@calvinjs/active-state";\nexport const ${name} = key("${name}", { n: 0 });`;
    expect(ids(lint("state-key-registration", slice("TIME"), "client/state/time.ts", cwd))).toEqual([]);
    expect(ids(lint("state-key-registration", slice("ORPHAN"), "client/state/orphan.ts", cwd))).toEqual(["unregisteredKey"]);
  });

  test("reports an unreadable registry instead of passing silently", () => {
    const cwd = scratch({});
    expect(ids(lint("state-key-registration", "export const x = 1;", "client/state/x.ts", cwd))).toEqual(["unknownRegistry"]);
  });
});
