/**
 * App config contract (PLAN.md C-A3): one JSON file per app under `spec/apps/`, validated here with zod and in
 * Rust with serde. Objects are loose: a field this side does not read yet (score rules, feed params) passes
 * through untouched, so the Rust side can grow the files without breaking the web.
 *
 * Pure: no runtime globals, so the browser, the workers, the Next routes and the eval harness share it.
 */
import { z } from "zod";

import { CATEGORY_IDS } from "../species-categories";

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

/** Every globe layer the client can draw. An app's `layers[]` picks the ones it shows. */
export const LAYER_IDS = ["sightings", "hotspots", "lst", "sst", "stations", "alerts", "missions", "peers", "notes"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const slug = z.string().regex(SLUG, "lower-case letters, digits and dashes");
const text = z.string().trim().min(1);
const lon = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);

export type BBox = { west: number; south: number; east: number; north: number };

/** `[W, S, E, N]` as in the contract, or the `{west, south, east, north}` object the GraphQL input uses. */
const bbox = z
  .union([z.tuple([lon, lat, lon, lat]), z.object({ west: lon, south: lat, east: lon, north: lat })])
  .transform((b): BBox => (Array.isArray(b) ? { west: b[0], south: b[1], east: b[2], north: b[3] } : { ...b }))
  .refine((b) => b.west < b.east && b.south < b.north, "bbox needs west < east and south < north");

const camera = z.looseObject({
  lat,
  lon,
  altitudeM: z.number().positive().max(20_000_000).optional(),
  heading: z.number().optional(),
  pitch: z.number().min(-90).max(0).optional(),
});

const region = z.looseObject({ id: slug, name: text, bbox, cellDeg: z.number().positive().max(5), camera: camera.optional() });

const taxon = z.looseObject({
  /** Filter key; derived from the name when absent. */
  id: slug.optional(),
  /** Common name. */
  name: text,
  /** Chip label ("Python"); the name when absent. */
  short: text.optional(),
  scientific: text.optional(),
  /** One plain line for the welcome guide. */
  line: text.optional(),
  /** Other names people use for it ("burmese python", "pterois"), matched lower case. */
  aliases: z.array(text).optional(),
  /** Category icon for the focus species (`shared/species-categories.ts`). */
  category: z.enum(CATEGORY_IDS).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "colour as #rrggbb"),
  halfLifeDays: z.number().positive().optional(),
});

const location = z.looseObject({ id: slug, name: text, lat, lon });

const feed = z.looseObject({ source: text, mode: z.enum(["push", "poll"]) });

const agent = z.preprocess(
  // Field names per C-A3 ("persona, scope text, tool allowlist, refusal text"); the long spellings are accepted too.
  (raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const a = raw as Record<string, unknown>;
    return { ...a, scope: a.scope ?? a.scopeText, tools: a.tools ?? a.toolAllowlist ?? a.allowlist, refusal: a.refusal ?? a.refusalText };
  },
  z.looseObject({ persona: text, scope: text, tools: z.array(text).min(1), refusal: text }),
);

const windows = z
  .looseObject({ default: z.number().int().positive(), options: z.array(z.number().int().positive()).min(1) })
  .refine((w) => w.options.includes(w.default), "windows.default must be one of windows.options");

export const appConfigSchema = z
  .looseObject({
    id: z.enum(APP_IDS),
    name: text,
    icon: text,
    tagline: text,
    question: text,
    kind: z.enum(["species", "conditions"]),
    taxa: z.array(taxon).default([]),
    regions: z.array(region).min(1),
    locations: z.array(location).default([]),
    feeds: z.array(feed).min(1),
    score: z.looseObject({ components: z.array(z.unknown()).min(1) }),
    windows,
    layers: z.array(z.enum(LAYER_IDS)).min(1),
    legend: z.union([z.string(), z.array(z.unknown()), z.looseObject({})]),
    copy: z.record(z.string(), z.unknown()),
    helperQuestions: z.array(text).min(1).max(8),
    agent,
    eval: z.preprocess((raw) => (typeof raw === "string" ? { goldenSet: raw } : raw), z.looseObject({ goldenSet: text })),
  })
  .superRefine((app, ctx) => {
    if (app.kind === "species" && app.taxa.length === 0) ctx.addIssue({ code: "custom", path: ["taxa"], message: "a species app needs at least one taxon" });
    if (app.kind === "conditions" && app.locations.length === 0)
      ctx.addIssue({ code: "custom", path: ["locations"], message: "a conditions app needs at least one location" });
    const keys = app.taxa.map(taxonKey);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["taxa"], message: "taxon ids must be unique" });
    const regionIds = app.regions.map((r) => r.id);
    if (new Set(regionIds).size !== regionIds.length) ctx.addIssue({ code: "custom", path: ["regions"], message: "region ids must be unique" });
  });

export type AppConfig = z.output<typeof appConfigSchema>;
export type AppRegion = AppConfig["regions"][number];
export type AppTaxon = AppConfig["taxa"][number];

/** A taxon's filter key: its `id`, else its name as a slug ("Burmese python" → "burmese-python"). */
export function taxonKey(taxon: { id?: string; name: string }): string {
  return taxon.id ?? taxon.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
