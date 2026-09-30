import { describe, expect, test } from "bun:test";

import plugin, { configs } from "@/eslint-plugins/inversa/plugin.mjs";

const RULES = ["prefer-catalog-constants", "require-use-client", "shared-purity", "state-key-registration", "test-mirror", "use-client-purity"];

describe("inversa plugin", () => {
  test("exposes the six ported rules", () => {
    expect(Object.keys(plugin.rules).sort()).toEqual(RULES);
  });

  test("the config enables every rule at error", () => {
    expect(configs).toHaveLength(1);
    expect(configs[0].rules).toEqual(Object.fromEntries(RULES.map((r) => [`inversa/${r}`, "error"])));
  });
});
