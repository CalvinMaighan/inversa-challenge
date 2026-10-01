/**
 * Evidence data for the drawer and the detection brackets: `evidence(id)`, `explainCell` and `backtest`
 * through `gqlRequest` (PLAN.md C16), with a small cache so reopening a record, or bracketing one the drawer
 * already loaded, costs no request.
 */
import type { FeedState } from "shared/feed-state";

import { parseEvidenceId } from "client/state/selection";
import { REGION_BBOX } from "client/state/view";
import { gqlRequest } from "client/threads/api";

import { FEED_FIELDS, feedLabel, formatLag, normalizeFeedState } from "../topbar/feed-chips";

export type EvidenceLink = { id: string; relation: string; source: string };

export type Evidence = {
  id: string;
  kind: string;
  record: Record<string, unknown>;
  raw: unknown;
  rawKey: string | null;
  sourceUrl: string | null;
  /** Publisher web page (PLAN.md C19), opened in a new tab; null when the publisher has none. */
  sourcePageUrl: string | null;
  fetchedAt: string | null;
  ingestLagSeconds: number | null;
  feed: FeedState | null;
  links: EvidenceLink[];
};

export type HotspotTerm = { name: string; value: number; rationale: string };
export type HotspotExplain = { cell: string; species: string; at: string; score: number; terms: HotspotTerm[] };
export type BacktestDay = { day: string; sightings: number; hits: number };
export type Backtest = { species: string; days: number; hitRate: number; baseline: number; perDay: BacktestDay[] };

export const EVIDENCE_QUERY = `query HudEvidence($id: ID!) {
  evidence(id: $id) {
    id kind record raw rawKey sourceUrl sourcePageUrl fetchedAt ingestLagSeconds
    feed { ${FEED_FIELDS} }
    links { id relation source }
  }
}`;

export const EXPLAIN_QUERY = `query HudExplain($cell: ID!, $species: ID!, $at: Time!) {
  explainCell(cell: $cell, species: $species, at: $at) { cell species at score terms { name value rationale } }
}`;

export const BACKTEST_QUERY = `query HudBacktest($species: ID!, $days: Int!) {
  backtest(species: $species, days: $days) { species days hitRate baseline perDay { day sightings hits } }
}`;

// ---------------------------------------------------------------- cache

const MAX_ENTRIES = 128;
const cache = new Map<string, Promise<unknown>>();

/** Memoize by key. A failed request is evicted so the next open retries. LRU by insertion order. */
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = load().catch((err: unknown) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, p);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return p;
}

/** Seed a result (fixtures, or a record another view already holds). */
export function primeCache(key: string, value: unknown): void {
  cache.set(key, Promise.resolve(value));
}

export const evidenceKey = (id: string) => `evidence:${id}`;
export const explainKey = (cell: string, species: string, at: string) => `explain:${species}:${cell}:${at}`;
export const backtestKey = (species: string, days: number) => `backtest:${species}:${days}`;

type RawEvidence = Omit<Evidence, "feed" | "record" | "links"> & { feed: unknown; record: unknown; links: EvidenceLink[] | null };

export function normalizeEvidence(raw: RawEvidence): Evidence {
  const record = raw.record && typeof raw.record === "object" && !Array.isArray(raw.record) ? (raw.record as Record<string, unknown>) : { value: raw.record };
  return {
    id: raw.id,
    kind: raw.kind,
    record,
    raw: raw.raw ?? null,
    rawKey: raw.rawKey ?? null,
    sourceUrl: raw.sourceUrl ?? null,
    sourcePageUrl: raw.sourcePageUrl ?? null,
    fetchedAt: raw.fetchedAt ?? null,
    ingestLagSeconds: raw.ingestLagSeconds ?? null,
    feed: normalizeFeedState(raw.feed),
    links: raw.links ?? [],
  };
}

export function loadEvidence(id: string, signal?: AbortSignal): Promise<Evidence> {
  return cached(evidenceKey(id), async () => {
    const data = await gqlRequest<{ evidence: RawEvidence }>(EVIDENCE_QUERY, { id }, signal);
    return normalizeEvidence(data.evidence);
  });
}

export function loadExplain(cell: string, species: string, at: string): Promise<HotspotExplain> {
  return cached(explainKey(cell, species, at), async () => {
    const data = await gqlRequest<{ explainCell: HotspotExplain }>(EXPLAIN_QUERY, { cell, species, at });
    return data.explainCell;
  });
}

export function loadBacktest(species: string, days: number): Promise<Backtest> {
  return cached(backtestKey(species, days), async () => {
    const data = await gqlRequest<{ backtest: Backtest }>(BACKTEST_QUERY, { species, days });
    return data.backtest;
  });
}

// ---------------------------------------------------------------- ids and links

/** 0.01° grid of PLAN.md C14/C15. */
export const CELL_DEG = 0.01;

export type HotspotRef = { species: string; cell: string; col: number; row: number; at: string };

/** `hotspot:<species>:<col>:<row>:<frame ms>` → parts, or null. */
export function parseHotspotId(id: string): HotspotRef | null {
  const parsed = parseEvidenceId(id);
  if (!parsed || parsed.kind !== "hotspot") return null;
  const m = /^([a-z_]+):(\d+):(\d+):(\d+)$/.exec(parsed.key);
  if (!m) return null;
  const ms = Number(m[4]);
  if (!Number.isFinite(ms)) return null;
  return { species: m[1]!, cell: `${m[2]}:${m[3]}`, col: Number(m[2]), row: Number(m[3]), at: new Date(ms).toISOString() };
}

/** `backtest:<species>:<days>` (PLAN.md C14) → parts, or null. */
export function parseBacktestId(id: string): { species: string; days: number } | null {
  const parsed = parseEvidenceId(id);
  if (!parsed || parsed.kind !== "backtest") return null;
  const m = /^([a-z_]+):(\d{1,3})$/.exec(parsed.key);
  return m && Number(m[2]) > 0 ? { species: m[1]!, days: Number(m[2]) } : null;
}

export function cellCenter(col: number, row: number): { lon: number; lat: number } {
  return { lon: REGION_BBOX.west + (col + 0.5) * CELL_DEG, lat: REGION_BBOX.south + (row + 0.5) * CELL_DEG };
}

export type LinkGroup = "duplicate_of" | "duplicates" | "revisions" | "conflicts" | "related";

/**
 * Group evidence links by relation (PRD §7: duplicate → `canonical_id`, conflicting → revision row and
 * conflict badge). Relation names are matched loosely so `duplicateOf`, `duplicate_of` and `canonical` agree.
 */
export function linkGroup(relation: string): LinkGroup {
  const r = relation.toLowerCase().replace(/[^a-z]/g, "");
  if (r === "duplicateof" || r === "canonical" || r === "canonicalid") return "duplicate_of";
  if (r.startsWith("duplicate")) return "duplicates";
  if (r.startsWith("revision") || r === "revisedby" || r === "revises") return "revisions";
  if (r.startsWith("conflict")) return "conflicts";
  return "related";
}

export function groupLinks(links: readonly EvidenceLink[]): Record<LinkGroup, EvidenceLink[]> {
  const out: Record<LinkGroup, EvidenceLink[]> = { duplicate_of: [], duplicates: [], revisions: [], conflicts: [], related: [] };
  for (const link of links) out[linkGroup(link.relation)].push(link);
  return out;
}

export type Revision = { changedAt: string | null; field: string; old: string | null; new: string | null };

/** Sighting revisions (iNat ID flips) have no id of their own; T10 lists them in `record.revisions`. */
export function recordRevisions(record: Record<string, unknown>): Revision[] {
  const list = record.revisions;
  if (!Array.isArray(list)) return [];
  const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return list
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => ({ changedAt: s(r.changedAt), field: String(r.field ?? ""), old: s(r.old), new: s(r.new) }));
}

export type BadgeGroup = Exclude<LinkGroup, "related">;

/**
 * Badge counts: links by relation, plus what the record carries itself (`revisions`, and the `conflict` flag
 * on a sighting whose disagreeing partner is not linked).
 */
export function evidenceBadges(evidence: Pick<Evidence, "links" | "record">): { group: BadgeGroup; count: number }[] {
  const groups = groupLinks(evidence.links);
  const count: Record<BadgeGroup, number> = {
    duplicate_of: groups.duplicate_of.length,
    duplicates: groups.duplicates.length,
    revisions: groups.revisions.length + recordRevisions(evidence.record).length,
    conflicts: new Set(groups.conflicts.map((l) => l.id)).size,
  };
  if (count.conflicts === 0 && evidence.record.conflict === true) count.conflicts = 1;
  return (Object.keys(count) as BadgeGroup[]).filter((g) => count[g] > 0).map((group) => ({ group, count: count[group] }));
}

/** A sighting stored more than a day after it was observed is late (the API's frame flag 4, `LATE_MS`). */
export const LATE_SECONDS = 24 * 3600;

export type QualityBadge = {
  badge: "late" | "missing" | "failed" | "feed" | "duplicate" | "conflict";
  /** Plain words for the summary (T41); the technical detail stays under "Details for experts". */
  label: string;
  state?: FeedState["state"];
};

const FLAG_WORDS: Record<string, string> = {
  cloud: "Cloud cover — no reading",
  bad_dqf: "Bad satellite data — no reading",
  missing: "No reading",
};
const FEED_WORDS: Record<string, string> = { lagging: "delayed", stale: "out of date", down: "not updating" };

/**
 * The PRD §7 cases of one record, in plain words for the evidence summary: a late report (with how late), a
 * reading with no usable value (cloud, bad DQF, missing), a failed data check, a duplicate or a disagreement
 * between sources, and the record's feed when it is not running normally.
 */
export function qualityBadges(evidence: Pick<Evidence, "kind" | "record" | "ingestLagSeconds" | "feed" | "links">): QualityBadge[] {
  const out: QualityBadge[] = [];
  const lag = evidence.ingestLagSeconds;
  if (evidence.kind === "sighting" && lag !== null && lag > LATE_SECONDS) out.push({ badge: "late", label: `Late report — reached us ${formatLag(lag)} after it was seen` });
  const flag = typeof evidence.record.flag === "string" ? evidence.record.flag.toLowerCase() : null;
  if (evidence.kind === "reading" && flag && flag !== "ok") out.push({ badge: "missing", label: FLAG_WORDS[flag] ?? "No reading" });
  if (evidence.kind === "fetch" && String(evidence.record.status ?? "").toLowerCase() === "error") out.push({ badge: "failed", label: "Data check failed" });
  const groups = groupLinks(evidence.links);
  if (groups.duplicate_of.length > 0) out.push({ badge: "duplicate", label: "Same animal as an earlier report" });
  else if (groups.duplicates.length > 0) {
    const n = new Set(groups.duplicates.map((l) => l.id)).size;
    out.push({ badge: "duplicate", label: `Also reported ${n === 1 ? "once more" : `${n} more times`} elsewhere` });
  }
  if (groups.conflicts.length > 0 || evidence.record.conflict === true) out.push({ badge: "conflict", label: "Sources disagree" });
  const feed = evidence.feed;
  if (feed && feed.state !== "nominal") out.push({ badge: "feed", label: `${feedLabel(feed.source)} data ${FEED_WORDS[feed.state] ?? feed.state}`, state: feed.state });
  return out;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Centre of a GeoJSON geometry's coordinates (bounding-box centre; enough to hang a bracket on). */
function geojsonCenter(geo: unknown): { lon: number; lat: number } | null {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  const walk = (v: unknown) => {
    if (!Array.isArray(v)) return;
    if (v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
      west = Math.min(west, v[0]);
      east = Math.max(east, v[0]);
      south = Math.min(south, v[1]);
      north = Math.max(north, v[1]);
      return;
    }
    for (const item of v) walk(item);
  };
  const g = geo as { coordinates?: unknown; geometry?: unknown; features?: unknown[] } | null;
  if (!g || typeof g !== "object") return null;
  if (g.coordinates) walk(g.coordinates);
  else if (g.geometry) return geojsonCenter(g.geometry);
  else if (Array.isArray(g.features)) for (const f of g.features) walk((f as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates);
  return Number.isFinite(west) ? { lon: (west + east) / 2, lat: (south + north) / 2 } : null;
}

/** Where to draw a bracket for an evidence record: its lat/lon, its station's, or its alert area's centre. */
export function evidenceLocation(record: Record<string, unknown>): { lon: number; lat: number } | null {
  const lat = num(record.lat);
  const lon = num(record.lon);
  if (lat !== null && lon !== null) return { lat, lon };
  const station = record.station as Record<string, unknown> | undefined;
  if (station && typeof station === "object") {
    const sl = num(station.lat);
    const so = num(station.lon);
    if (sl !== null && so !== null) return { lat: sl, lon: so };
  }
  return geojsonCenter(record.areaGeojson ?? record.area_geojson ?? null);
}
