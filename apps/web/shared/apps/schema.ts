/**
 * App config contract (PLAN.md C-A3): one JSON file per app under `spec/apps/`, documented by
 * `spec/apps/app-config.schema.json` and loaded by Rust (`api/src/app/config.rs`, serde with `deny_unknown_fields`)
 * and here (zod). Both sides accept exactly the same files: objects are strict (an unknown key is an error), there
 * are no alternative spellings, and every rule `AppConfig::validate` enforces is enforced here too. The shared
 * corpus `spec/apps/invalid/*.json` and the "app config conformance" tests hold the two in step.
 *
 * Pure: no runtime globals, so the browser, the workers, the Next routes and the eval harness share it.
 */
import { z } from "zod";

/** App ids (C-A1). Order is the selector's order; the default is carp. */
export const APP_IDS = ["carp", "lionfish", "python"] as const;
export type AppId = (typeof APP_IDS)[number];
export const DEFAULT_APP_ID: AppId = APP_IDS[0];

export function isAppId(value: unknown): value is AppId {
  return typeof value === "string" && (APP_IDS as readonly string[]).includes(value);
}

/** Team board id and RTC room of an app (C-A6): `<app>:main`. */
export function boardIdFor(id: AppId): string {
  return `${id}:main`;
}

/**
 * Every globe layer the client can draw. An app's `layers[]` may also name layers the client does not draw yet
 * (lionfish `heat`, carp `locations`); those are listed in the config and skipped by the client.
 */
export const LAYER_IDS = ["sightings", "hotspots", "lst", "sst", "stations", "alerts", "missions", "peers", "notes"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export function isLayerId(value: unknown): value is LayerId {
  return typeof value === "string" && (LAYER_IDS as readonly string[]).includes(value);
}

/** Feed sources and the mode each adapter runs in (`api/src/app/config.rs` `SOURCES`). */
export const FEED_SOURCES = {
  inat: "poll",
  nas: "poll",
  gbif: "poll",
  nws: "poll",
  usgs: "poll",
  ndbc: "poll",
  coops: "poll",
  openmeteo: "poll",
  goes19: "push",
  nwws: "push",
  crw: "poll",
  nwps: "poll",
  "openmeteo-marine": "poll",
  "goes19-sst": "push",
  "nws-alerts": "poll",
  "nws-forecast": "poll",
  iem: "poll",
} as const;
export type FeedSource = keyof typeof FEED_SOURCES;
const SOURCE_IDS = Object.keys(FEED_SOURCES) as [FeedSource, ...FeedSource[]];

/** Activity/access rule sets (`api/src/hotspot/rules.rs`). */
export const RULE_SETS = ["python", "lionfish"] as const;

/** IANA zones `copy.timezone` may name (`TIMEZONES` in config.rs; the schema's enum). */
export const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
  "America/Cancun",
  "America/Merida",
  "America/Belize",
  "America/Bogota",
  "America/Havana",
  "America/Nassau",
  "America/Jamaica",
  "America/Panama",
  "America/Costa_Rica",
  "UTC",
] as const;

export const MAX_HELPER_QUESTIONS = 8;

/** A region edge is a whole number of this many scoring cells (hotspot grid 2 cells, environment grid 5). */
export const GRID_MULTIPLE = 10;

const ID = /^[a-z][a-z0-9-]*$/;
const id = z.string().regex(ID, "lower-case kebab-case id");
/** Non-blank text. Not trimmed in the output: Rust keeps the string as written, so must the web. */
const text = z.string().refine((s) => s.trim().length > 0, "must not be blank");
const finite = z.number().refine(Number.isFinite, "must be finite");
const positive = finite.refine((n) => n > 0, "must be positive");
const posInt = z.number().int().min(1);
const hours = z.number().int().min(1).max(0xffff_ffff);

export type BBox = { west: number; south: number; east: number; north: number };

/** `[west, south, east, north]` in the file, `{west, south, east, north}` in memory. */
const bbox = z.tuple([finite, finite, finite, finite]).transform((b): BBox => ({ west: b[0], south: b[1], east: b[2], north: b[3] }));

const camera = z.strictObject({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), heightM: positive });

const region = z.strictObject({ id, name: text, code: z.string().regex(/^[a-z][a-z0-9]*$/).optional(), bbox, cellDeg: positive, camera, thin: z.boolean().default(false) });

const taxon = z.strictObject({
  id,
  /** Common name. */
  name: text,
  /** Chip label ("Python"); the name when absent. */
  short: text.optional(),
  /** One plain line for the welcome guide. */
  line: text.optional(),
  /** Other names people use for it ("burmese python", "pterois"), matched lower case. */
  aliases: z.array(text).optional(),
  scientificName: text,
  inatTaxonId: posInt.optional(),
  inatLineageIds: z.array(posInt).optional(),
  gbifKey: posInt.optional(),
  nasGenus: text.optional(),
  nasSpecies: z.string().nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "colour as #rrggbb"),
  halfLifeDays: positive,
  rules: z.enum(RULE_SETS),
});

const location = z.strictObject({
  id,
  name: text,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  usgs: z.string().nullable().optional(),
  nwps: z.string().nullable().optional(),
  nws: z.string().nullable().optional(),
  /** NWS forecast grid cell (`/points` gridId, gridX, gridY), so the gridpoint poller needs no lookup (C4). */
  nwsGrid: z.strictObject({ office: text, x: z.number().int().min(0), y: z.number().int().min(0) }).optional(),
  /** UGC codes of the location (forecast zone, county): zone-based alerts match a site through these. */
  nwsZones: z.array(text).optional(),
  /** Why the site is in the set; data caveats (datum, missing discharge). */
  note: z.string().optional(),
  provisional: z.boolean().default(false),
});

/** A named map camera for the preset list (conditions apps): `zoom` is a web-map zoom level. */
const cameraPreset = z.strictObject({
  id,
  name: text,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  zoom: z.number().gt(0).max(24),
  /** Location ids the preset frames; empty = all. */
  locations: z.array(id).optional(),
});

const feed = z
  .strictObject({
    source: z.enum(SOURCE_IDS),
    mode: z.enum(["push", "poll"]),
    name: z.string().optional(),
    homepage: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((f) => FEED_SOURCES[f.source] === f.mode, { message: "mode is not the mode its source runs in", path: ["mode"] });

const score = z.strictObject({
  label: z.string(),
  components: z.array(z.strictObject({ id: z.string(), label: z.string(), weight: finite.min(0), description: z.string().optional() })).min(1),
});

const windows = z
  .strictObject({ defaultHours: hours, optionsHours: z.array(hours).min(1) })
  .refine((w) => w.optionsHours.includes(w.defaultHours), "windows.defaultHours must be one of windows.optionsHours");

const layer = z.strictObject({ id, label: z.string(), defaultOn: z.boolean(), description: z.string().optional() });

const copy = z.object({ about: text, region: text, timezone: z.enum(TIMEZONES) }).catchall(z.string());

const agent = z.strictObject({ persona: text, scope: text, tools: z.array(text).min(1), refusal: text });

/** Edges of `b` in `cellDeg` cells, when each is a whole multiple of GRID_MULTIPLE (config.rs `grid_of`). */
function gridProblem(b: BBox, cellDeg: number): string | null {
  if (!(b.west < b.east && b.south < b.north)) return "bbox needs west < east and south < north";
  if (b.south < -90 || b.north > 90 || b.west < -180 || b.east > 180) return "bbox leaves the globe";
  for (const [what, span] of [
    ["width", b.east - b.west],
    ["height", b.north - b.south],
  ] as const) {
    const n = span / cellDeg;
    const cells = Math.round(n);
    if (Math.abs(n - cells) > 1e-6 || cells < 1 || cells > 1e6) return `${what} is not a whole number of ${cellDeg} deg cells`;
    if (cells % GRID_MULTIPLE !== 0) return `${what} is ${cells} cells; must be a multiple of ${GRID_MULTIPLE}`;
  }
  return null;
}

const overlaps = (a: BBox, b: BBox) => a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;

export const appConfigSchema = z
  .strictObject({
    id: z.enum(APP_IDS),
    name: text,
    icon: text,
    tagline: text,
    question: text,
    kind: z.enum(["species", "conditions"]),
    provisional: z.boolean().default(false),
    taxa: z.array(taxon).max(1),
    regions: z.array(region).min(1).max(255),
    locations: z.array(location),
    cameraPresets: z.array(cameraPreset).optional(),
    feeds: z.array(feed).min(1),
    score,
    windows,
    layers: z.array(layer),
    legend: z.record(z.string(), z.string()),
    copy,
    helperQuestions: z.array(text).min(1).max(MAX_HELPER_QUESTIONS),
    agent,
    eval: z.strictObject({ goldenSet: text }),
    review: z.strictObject({
      stageRiseFt: positive.optional(),
      tidalSites: z.array(text).optional(),
      tidalStageRiseFt: positive.optional(),
      forecastHorizonHours: positive.optional(),
      rapidRiseFtPer24h: positive.optional(),
      tidalRapidRiseFtPer24h: positive.optional(),
      staleObservationHours: positive.optional(),
      staleForecastHours: positive.optional(),
      conflictFt: positive.optional(),
      flowConflictRatio: z.number().gt(1).optional(),
    }).optional(),
  })
  .superRefine((app, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const dupes = (list: readonly string[]) => list.filter((v, i) => list.indexOf(v) !== i);
    if (app.kind === "species" && app.taxa.length === 0) issue(["taxa"], "kind species needs at least one taxon");
    if (app.kind === "conditions" && app.taxa.length > 0) issue(["taxa"], "kind conditions must list no taxa");
    if (app.kind === "conditions" && app.locations.length === 0) issue(["locations"], "kind conditions needs at least one location");
    if (dupes(app.regions.map((r) => r.id)).length) issue(["regions"], "region ids must be unique");
    app.regions.forEach((r, i) => {
      const problem = gridProblem(r.bbox, r.cellDeg);
      if (problem) issue(["regions", i, "bbox"], problem);
      for (const other of app.regions.slice(0, i)) if (overlaps(r.bbox, other.bbox)) issue(["regions", i, "bbox"], `overlaps region ${other.id}`);
    });
    if (dupes(app.locations.map((l) => l.id)).length) issue(["locations"], "location ids must be unique");
    if (app.kind === "conditions") {
      app.locations.forEach((l, i) => {
        if (!app.regions.some((r) => r.bbox.south <= l.lat && l.lat <= r.bbox.north && r.bbox.west <= l.lon && l.lon <= r.bbox.east))
          issue(["locations", i], "lies outside every region");
      });
    }
    for (const key of ["usgs", "nwps"] as const) {
      if (dupes(app.locations.map((l) => l[key]).filter((v): v is string => typeof v === "string")).length) issue(["locations"], `${key} ids must be unique`);
    }
    const presets = app.cameraPresets ?? [];
    if (dupes(presets.map((p) => p.id)).length) issue(["cameraPresets"], "preset ids must be unique");
    presets.forEach((p, i) => {
      for (const loc of p.locations ?? []) if (!app.locations.some((l) => l.id === loc)) issue(["cameraPresets", i, "locations"], `unknown location ${loc}`);
    });
    if (dupes(app.feeds.map((f) => f.source)).length) issue(["feeds"], "a source is listed twice");
    if (dupes(app.score.components.map((c) => c.id)).length) issue(["score", "components"], "component ids must be unique");
    const layerIds = app.layers.map((l) => l.id);
    if (dupes(layerIds).length) issue(["layers"], "layer ids must be unique");
    for (const key of Object.keys(app.legend)) if (!layerIds.includes(key)) issue(["legend", key], "names no layer in layers[]");
    if (dupes(app.agent.tools).length) issue(["agent", "tools"], "a tool is listed twice");
  });

export type AppConfig = z.output<typeof appConfigSchema>;
export type AppRegion = AppConfig["regions"][number];
export type AppTaxon = AppConfig["taxa"][number];
export type AppLayer = AppConfig["layers"][number];

/** A taxon's filter key: its `id`. */
export function taxonKey(taxon: { id: string }): string {
  return taxon.id;
}

export type AppConfigIssue = { path: string; message: string };

/** A config file that does not match the contract. `appId` is the file's app (null when it could not be read). */
export class AppConfigError extends Error {
  readonly name = "AppConfigError";
  constructor(
    readonly appId: string | null,
    readonly issues: readonly AppConfigIssue[],
  ) {
    super(`app config ${appId ?? "?"} is invalid: ${issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ")}`);
  }
}

/** Validate one config. `expectedId` (the file name) must match its `id`. Throws AppConfigError. */
export function parseAppConfig(raw: unknown, expectedId?: string): AppConfig {
  const claimed = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : null;
  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppConfigError(
      expectedId ?? claimed,
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  if (expectedId !== undefined && parsed.data.id !== expectedId) {
    throw new AppConfigError(expectedId, [{ path: "id", message: `is "${parsed.data.id}", expected "${expectedId}"` }]);
  }
  return parsed.data;
}

/** Validate the full set: exactly one config per app id. */
export function parseApps(raw: Readonly<Record<string, unknown>>): Readonly<Record<AppId, AppConfig>> {
  const missing = APP_IDS.filter((id) => !(id in raw));
  if (missing.length) throw new AppConfigError(null, missing.map((id) => ({ path: id, message: "config file missing" })));
  const extra = Object.keys(raw).filter((id) => !isAppId(id));
  if (extra.length) throw new AppConfigError(extra[0]!, extra.map((id) => ({ path: id, message: "not an app id" })));
  return Object.freeze(Object.fromEntries(APP_IDS.map((id) => [id, Object.freeze(parseAppConfig(raw[id], id))])) as Record<AppId, AppConfig>);
}
