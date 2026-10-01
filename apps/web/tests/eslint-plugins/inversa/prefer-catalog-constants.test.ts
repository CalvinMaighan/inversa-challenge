import { describe, expect, test } from "bun:test";

import { CATALOG_VOCABULARY, CONSTANT_MODULE } from "@/eslint-plugins/inversa/prefer-catalog-constants.mjs";
import { APP_IDS, LAYER_IDS } from "shared/apps";
import { QUALITY_CODES } from "shared/frames";

import { ids, lint } from "./lint";

const run = (code: string, filename = "client/hud/Filters.tsx") => lint("prefer-catalog-constants", code, filename);

describe("prefer-catalog-constants", () => {
  test("vocabulary mirrors the shared/ constants", () => {
    expect(CATALOG_VOCABULARY.APP_IDS).toEqual([...APP_IDS]);
    expect(CATALOG_VOCABULARY.LAYER_IDS).toEqual([...LAYER_IDS]);
    expect(CATALOG_VOCABULARY.QUALITY_CODES).toEqual([...QUALITY_CODES]);
    expect(CONSTANT_MODULE).toEqual({ APP_IDS: "shared/apps", LAYER_IDS: "shared/apps", QUALITY_CODES: "shared/frames" });
  });

  test("flags a retyped vocabulary literal and names the constant", () => {
    const [message] = run('const s = "python";');
    expect(message?.messageId).toBe("preferConstant");
    expect(message?.message).toContain('APP_IDS from "shared/apps"');
    expect(ids(run('if (layer === "hotspots") {}'))).toEqual(["preferConstant"]);
    expect(ids(run('const q = ["research", "casual"];', "server/agent/tools.ts"))).toEqual(["preferConstant", "preferConstant"]);
  });

  test("allows other strings, capitalised labels and module specifiers", () => {
    expect(ids(run('const label = "Sightings"; const t = "python snake";'))).toEqual([]);
    // Species are config now (PLAN.md C-A3), not a shared constant.
    expect(ids(run('const s = "tegu";'))).toEqual([]);
    expect(ids(run('import x from "./hotspots";'))).toEqual([]);
  });

  test("exempts shared/, tests/ and eval/", () => {
    expect(ids(run('export const S = ["python"] as const;', "shared/x.ts"))).toEqual([]);
    expect(ids(run('const s = "python";', "tests/client/x.test.ts"))).toEqual([]);
    expect(ids(run('const s = "python";', "eval/cases.ts"))).toEqual([]);
  });
});
