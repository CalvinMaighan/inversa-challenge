import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  APP_IDS,
  AppConfigError,
  DEFAULT_APP_ID,
  FEED_SOURCES,
  getApp,
  isAppId,
  loadApps,
  MAX_HELPER_QUESTIONS,
  parseAppConfig,
  parseApps,
  RULE_SETS,
  taxonKey,
  TIMEZONES,
} from "shared/apps";
import { CATEGORY_IDS } from "shared/species-categories";

/** The contract files (PLAN.md C-A3), shared with the Rust loader (api/src/app/config.rs). */
const SPEC = path.resolve(import.meta.dir, "../../../../../spec/apps");
const INVALID = path.join(SPEC, "invalid");

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const spec = (id: string) => readJson(path.join(SPEC, `${id}.json`)) as Record<string, unknown>;

describe("app config conformance", () => {
  test("app config conformance: every file in spec/apps parses, one per app id", () => {
    const files = readdirSync(SPEC).filter((f) => f.endsWith(".json") && !f.endsWith(".schema.json"));
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual([...APP_IDS].sort());
    const apps = parseApps(Object.fromEntries(files.map((f) => [f.replace(/\.json$/, ""), readJson(path.join(SPEC, f))])));
    for (const id of APP_IDS) expect(apps[id].id).toBe(id);
  });

  test("app config conformance: the bundled configs are the spec files (tsconfig app-configs/* points at spec/apps)", () => {
    for (const id of APP_IDS) expect(getApp(id)).toEqual(parseAppConfig(spec(id), id));
  });

  // Each file breaks one rule; Rust refuses every one too (app_config_conformance_rejects_the_shared_invalid_corpus).
  const corpus = readdirSync(INVALID).filter((f) => f.endsWith(".json"));
  test("app config conformance: the shared invalid corpus is not empty", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(20);
  });
  for (const file of corpus) {
    test(`app config conformance: refuses invalid/${file} on the field it names`, () => {
      const raw = readJson(path.join(INVALID, file)) as { id?: string };
      let err: unknown;
      try {
        parseAppConfig(raw);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppConfigError);
      const field = file.startsWith("unknown-field") ? "" : file.split(".")[0]!;
      const paths = (err as AppConfigError).issues.map((i) => i.path.split(".")[0]);
      expect(paths).toContain(field);
    });
  }

  test("app config conformance: closed lists equal the schema's enums (and Rust's, by its own test)", () => {
    type Enum = { enum: string[] };
    type Items = { items: { properties: Record<string, Enum> } };
    const p = (readJson(path.join(SPEC, "app-config.schema.json")) as { properties: Record<string, unknown> }).properties;
    expect((p.id as Enum).enum).toEqual([...APP_IDS]);
    expect((p.feeds as Items).items.properties.source!.enum).toEqual(Object.keys(FEED_SOURCES));
    expect((p.taxa as Items).items.properties.category!.enum).toEqual([...CATEGORY_IDS]);
    expect((p.taxa as Items).items.properties.rules!.enum).toEqual([...RULE_SETS]);
    expect((p.copy as { properties: Record<string, Enum> }).properties.timezone!.enum).toEqual([...TIMEZONES]);
    expect((p.helperQuestions as { maxItems: number }).maxItems).toBe(MAX_HELPER_QUESTIONS);
    // Every listed zone is a real IANA zone to this runtime.
    for (const zone of TIMEZONES) expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })).not.toThrow();
  });

  test("app config conformance: loadApps() validates the bundled files once and returns frozen configs", () => {
    const apps = loadApps();
    expect(Object.keys(apps)).toEqual([...APP_IDS]);
    expect(loadApps()).toBe(apps);
    expect(Object.isFrozen(apps.carp)).toBe(true);
    expect(getApp("lionfish").regions.map((r) => r.id)).toEqual(["fl-keys", "mx-caribbean", "belize", "co-caribbean"]);
  });

  test("app config conformance: carp is the default and the only conditions app; python keeps the four focus species in frame order", () => {
    expect(DEFAULT_APP_ID).toBe("carp");
    expect(getApp("carp").kind).toBe("conditions");
    expect(getApp("python").taxa.map(taxonKey)).toEqual(["python", "tegu", "iguana", "lionfish"]);
    expect(getApp("python").regions[0]!.bbox).toEqual({ west: -83.2, south: 24.3, east: -79.8, north: 27.5 });
    expect(getApp("python").regions[0]!.camera.heightM).toBeGreaterThan(0);
    expect(getApp("carp").copy.timezone).toBe("America/Chicago");
  });

  test("app config conformance: isAppId accepts the three ids only", () => {
    expect(APP_IDS.every(isAppId)).toBe(true);
    for (const bad of ["", "Carp", "everglades", null, 3, "carp "]) expect(isAppId(bad)).toBe(false);
  });
});

describe("app config errors", () => {
  const throws = (fn: () => unknown): AppConfigError => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(AppConfigError);
      return err as AppConfigError;
    }
    throw new Error("expected AppConfigError");
  };

  test("app config: a missing field fails with a typed error naming the app and the path", () => {
    const raw = spec("carp");
    delete raw.helperQuestions;
    const err = throws(() => parseAppConfig(raw, "carp"));
    expect(err.name).toBe("AppConfigError");
    expect(err.appId).toBe("carp");
    expect(err.issues.map((i) => i.path)).toContain("helperQuestions");
  });

  test("app config: the file name must match the id, and the set must be complete", () => {
    expect(throws(() => parseAppConfig(spec("python"), "carp")).issues[0]).toEqual({ path: "id", message: 'is "python", expected "carp"' });
    expect(throws(() => parseApps({ carp: spec("carp"), python: spec("python") })).issues).toEqual([{ path: "lionfish", message: "config file missing" }]);
    expect(throws(() => parseApps({ carp: spec("carp"), lionfish: spec("lionfish"), python: spec("python"), cod: {} })).appId).toBe("cod");
  });

  test("app config: layers the client does not draw yet are accepted as config", () => {
    const lionfish = getApp("lionfish");
    expect(lionfish.layers.map((l) => l.id)).toContain("heat");
  });
});
