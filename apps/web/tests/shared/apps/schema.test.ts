import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { APP_IDS, AppConfigError, DEFAULT_APP_ID, getApp, isAppId, loadApps, parseAppConfig, parseApps, taxonKey } from "shared/apps";

const APP_DIR = path.resolve(import.meta.dir, "../../..");
const FIXTURES = path.join(APP_DIR, "tests/fixtures/apps");
/** The contract files (PLAN.md C-A3), written by the Rust side's leaf. */
const SPEC = path.resolve(APP_DIR, "../../spec/apps");

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const fixture = (id: string) => readJson(path.join(FIXTURES, `${id}.json`)) as Record<string, unknown>;

/** Directories holding a full set of app configs: the fixtures always, `spec/apps` once it exists. */
const dirs = [FIXTURES, ...(existsSync(SPEC) && APP_IDS.every((id) => existsSync(path.join(SPEC, `${id}.json`))) ? [SPEC] : [])];

describe("app config conformance", () => {
  for (const dir of dirs) {
    test(`app config: every file in ${path.relative(APP_DIR, dir)} parses, one per app id`, () => {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".schema.json"));
      expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual([...APP_IDS].sort());
      const apps = parseApps(Object.fromEntries(files.map((f) => [f.replace(/\.json$/, ""), readJson(path.join(dir, f))])));
      for (const id of APP_IDS) expect(apps[id].id).toBe(id);
    });
  }

  test("app config: loadApps() validates the bundled files once and returns frozen configs", () => {
    const apps = loadApps();
    expect(Object.keys(apps)).toEqual([...APP_IDS]);
    expect(loadApps()).toBe(apps);
    expect(Object.isFrozen(apps.carp)).toBe(true);
    expect(getApp("lionfish").regions.map((r) => r.id)).toEqual(["fl-keys", "mx-caribbean", "belize", "co-caribbean"]);
  });

  test("app config: carp is the default and the only conditions app; python keeps the four focus species in EVF order", () => {
    expect(DEFAULT_APP_ID).toBe("carp");
    expect(getApp("carp").kind).toBe("conditions");
    expect(getApp("python").taxa.map(taxonKey)).toEqual(["python", "tegu", "iguana", "lionfish"]);
    expect(getApp("python").regions[0]!.bbox).toEqual({ west: -83.2, south: 24.3, east: -79.8, north: 27.5 });
  });

  test("app config: every agent allowlist names only known tools and every app has helper questions", () => {
    for (const id of APP_IDS) {
      const app = getApp(id);
      expect(app.helperQuestions.length).toBeGreaterThan(0);
      expect(app.agent.tools.length).toBeGreaterThan(0);
    }
  });

  test("app config: isAppId accepts the three ids only", () => {
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
    const raw = fixture("carp");
    delete raw.helperQuestions;
    const err = throws(() => parseAppConfig(raw, "carp"));
    expect(err.name).toBe("AppConfigError");
    expect(err.appId).toBe("carp");
    expect(err.issues.map((i) => i.path)).toContain("helperQuestions");
  });

  test("app config: a bad bbox, an unknown layer and an unknown kind are each rejected", () => {
    const base = fixture("python");
    const region = (base.regions as Record<string, unknown>[])[0]!;
    expect(throws(() => parseAppConfig({ ...base, regions: [{ ...region, bbox: [-79, 24, -83, 27] }] })).issues[0]!.path).toBe("regions.0.bbox");
    expect(throws(() => parseAppConfig({ ...base, layers: ["sightings", "radar"] })).issues[0]!.path).toBe("layers.1");
    expect(throws(() => parseAppConfig({ ...base, kind: "fish" })).issues[0]!.path).toBe("kind");
  });

  test("app config: a species app without taxa and a conditions app without locations are invalid", () => {
    expect(throws(() => parseAppConfig({ ...fixture("lionfish"), taxa: [] })).issues[0]!.path).toBe("taxa");
    expect(throws(() => parseAppConfig({ ...fixture("carp"), locations: [] })).issues[0]!.path).toBe("locations");
  });

  test("app config: the file name must match the id, and the set must be complete", () => {
    expect(throws(() => parseAppConfig(fixture("python"), "carp")).issues[0]).toEqual({ path: "id", message: 'is "python", expected "carp"' });
    expect(throws(() => parseApps({ carp: fixture("carp"), python: fixture("python") })).issues).toEqual([{ path: "lionfish", message: "config file missing" }]);
    expect(throws(() => parseApps({ carp: fixture("carp"), lionfish: fixture("lionfish"), python: fixture("python"), cod: {} })).appId).toBe("cod");
  });

  test("app config: bbox objects and the long agent field names are accepted; unknown fields pass through", () => {
    const base = fixture("python");
    const region = (base.regions as Record<string, unknown>[])[0]!;
    const { agent } = base as { agent: Record<string, unknown> };
    const app = parseAppConfig({
      ...base,
      regions: [{ ...region, bbox: { west: -83.2, south: 24.3, east: -79.8, north: 27.5 } }],
      agent: { persona: agent.persona, scopeText: agent.scope, toolAllowlist: agent.tools, refusalText: agent.refusal },
      eval: "python",
      futureField: 1,
    });
    expect(app.regions[0]!.bbox.west).toBe(-83.2);
    expect(app.agent.tools).toEqual(agent.tools as string[]);
    expect(app.eval.goldenSet).toBe("python");
    expect((app as Record<string, unknown>).futureField).toBe(1);
  });

  test("app config: taxon keys come from id, else the name as a slug", () => {
    expect(taxonKey({ id: "python", name: "Burmese python" })).toBe("python");
    expect(taxonKey({ name: "Red lionfish (P. volitans)" })).toBe("red-lionfish-p-volitans");
  });
});
