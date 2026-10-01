import { get, key, set } from "@calvinjs/active-state";

import { activeApp } from "./app";

/**
 * Carp view state (leaf UC; the agent's `set_view` emits the same three fields, leaf AG1):
 *
 * - `site`: the selected location, by its NWPS lid (`locations[].nwps`, e.g. `KRZL1`). Absent: none selected.
 * - `asOf`: the "what we knew" time, unix ms. Absent: live. Every carp panel then shows what was knowable at that
 *   moment (the forecast issued at or before it, observations up to it) and draws later observations apart.
 * - `replay`: play forward from `asOf` (one hour per tick) until now, then return to live.
 *
 * Only a conditions app reads it; an app switch clears it.
 */
export type CarpState = { site?: string; asOf?: number; replay?: boolean };

export const CARP = key("CARP", {} as CarpState);

/** How far back "what we knew" may go: the 30 days the stores keep. */
export const ASOF_MAX_AGE_MS = 30 * 24 * 3_600_000;

/** NWPS lids of the active app's locations (empty for a species app). */
export function carpSiteIds(): string[] {
  return activeApp()
    .locations.map((l) => l.nwps)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * A site id from any writer (UI, agent, share link): the NWPS lid in any case, or the location's config id
 * (`atchafalaya-krotz-springs`); undefined unless it names a configured location.
 */
export function normalizeSite(site: unknown, locations: readonly { id: string; nwps?: string | null }[] = activeApp().locations): string | undefined {
  if (typeof site !== "string") return undefined;
  const raw = site.trim();
  const hit = locations.find((l) => l.nwps && (l.nwps === raw.toUpperCase() || l.id === raw));
  return hit?.nwps ?? undefined;
}

/**
 * An as-of time from any writer, clamped into [now − 30 days, now] and floored to the minute. At or within a minute
 * of now it is live (undefined): "what we knew now" is the live view. Non-numbers are live too.
 */
export function normalizeAsOf(asOf: unknown, nowMs: number): number | undefined {
  const ms = typeof asOf === "string" ? Date.parse(asOf) : typeof asOf === "number" ? asOf : NaN;
  if (!Number.isFinite(ms)) return undefined;
  const clamped = Math.min(nowMs, Math.max(nowMs - ASOF_MAX_AGE_MS, ms));
  if (nowMs - clamped < 60_000) return undefined;
  return Math.floor(clamped / 60_000) * 60_000;
}

function compact(state: CarpState): CarpState {
  const out: CarpState = {};
  if (state.site) out.site = state.site;
  if (state.asOf !== undefined) out.asOf = state.asOf;
  if (state.replay && state.asOf !== undefined) out.replay = true;
  return out;
}

/**
 * Apply a partial view (the agent's `view` event, a share link, a control). A field left out keeps its value;
 * `null` clears it. Invalid sites are ignored, times are clamped; `replay` needs a past `asOf`.
 */
export function applyCarpView(view: { site?: string | null; asOf?: number | string | null; replay?: boolean | null }, nowMs = Date.now()): void {
  const locations = activeApp().locations;
  set<CarpState>(CARP, (prev = CARP.defaults) => {
    const next: CarpState = { ...prev };
    if (view.site === null) delete next.site;
    else if (view.site !== undefined) {
      const site = normalizeSite(view.site, locations);
      if (site) next.site = site;
    }
    if (view.asOf === null) delete next.asOf;
    else if (view.asOf !== undefined) next.asOf = normalizeAsOf(view.asOf, nowMs);
    if (view.replay !== undefined) next.replay = view.replay === true;
    return compact(next);
  });
}

export function selectSite(site: string | null): void {
  applyCarpView({ site });
}

/** "What we knew" at `asOfMs` (live when it is now); stops a replay. */
export function setAsOf(asOfMs: number | null, nowMs = Date.now()): void {
  applyCarpView({ asOf: asOfMs, replay: false }, nowMs);
}

export function goLive(): void {
  applyCarpView({ asOf: null, replay: false });
}

export function carpState(): CarpState {
  return get<CarpState>(CARP) ?? CARP.defaults;
}
