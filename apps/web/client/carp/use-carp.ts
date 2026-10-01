"use client";

import { useEffect, useMemo, useState } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { CARP, type CarpState } from "client/state/carp";
import type { AppConfig } from "shared/apps";

import { boardInputs, loadBoard, loadC5Board, loadC5History, loadSiteHistory, loadSiteReadings, loadSiteStatusAt, loadVerifyMany, type BoardData, type SiteAt, type SiteHistory, type SiteStatusAt } from "./data";
import { forecastAsOf, HOUR, isRiverForecast, thresholdList, type Site, type VerifyPoint } from "./model";
import { deriveReview, reviewAt, withThresholdsLater, type ReviewHistory, type SiteReview } from "./review";

/** The carp view state (site, asOf, replay). */
export function useCarp(): CarpState {
  return useActiveState<CarpState>(CARP)[0] ?? CARP.defaults;
}

/** Wall clock, re-read every `everyMs` (the live edge moves with it, and live data is re-read). */
export function useNow(everyMs = LIVE_REFRESH_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Live data is re-read this often (the e2e stack's sources are off; production pollers write every 15 min). */
const LIVE_REFRESH_MS = 60_000;
/** Scrubbing settles before the board refetches. */
const ASOF_DEBOUNCE_MS = 250;

export type BoardState = {
  /** The time the reviews describe. */
  asOfMs: number | null;
  data: BoardData | null;
  reviews: Record<string, SiteReview>;
  loading: boolean;
  error: string | null;
};

/**
 * The review board at `asOfMs` (live: now, refreshed every minute). Statuses come from C5 (`reviewBoard` live;
 * past times from each site's `reviewHistory` over the chart span, fetched once per minute and answered from
 * memory, so a scrub costs no request). An API without C5 falls back to the browser's derivation, labelled
 * `derived`, which re-reads per time once scrubbing settles.
 */
export function useBoard(app: AppConfig, sites: readonly Site[], asOfMs: number | undefined, nowMs: number, span: { fromMs: number; toMs: number }, scrubbing = false): BoardState {
  const [live, setLive] = useState<{ nowMs: number; data: BoardData; reviews: Record<string, SiteReview>; c5: boolean } | null>(null);
  const [history, setHistory] = useState<{ nowMs: number; byLid: Record<string, ReviewHistory> } | null>(null);
  const [derived, setDerived] = useState<{ asOfMs: number; data: BoardData; reviews: Record<string, SiteReview> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isLive = asOfMs === undefined;
  const fromMs = span.fromMs;

  // Live board and the sites' review histories: once per minute tick, held back while a drag is in progress.
  useEffect(() => {
    if (scrubbing) return;
    const controller = new AbortController();
    const run = async () => {
      try {
        const [data, c5, hist] = await Promise.all([loadBoard(app, sites, nowMs, controller.signal), loadC5Board(nowMs, controller.signal), loadC5History(sites, fromMs, nowMs, controller.signal)]);
        if (controller.signal.aborted) return;
        const reviews: Record<string, SiteReview> = {};
        for (const site of sites) {
          const served = c5?.[site.lid];
          reviews[site.lid] = served ?? deriveReview({ site, asOfMs: nowMs, live: true, zone: app.copy.timezone, ...boardInputs(data, site) });
        }
        setLive({ nowMs, data, reviews, c5: c5 !== null });
        if (hist) setHistory({ nowMs, byLid: hist });
        setError(null);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void run();
    return () => controller.abort();
    // `scrubbing` only holds the refresh back; the release runs it.
  }, [app, sites, nowMs, fromMs, scrubbing]);

  // A past time the histories do not cover (an API without C5, or a time outside the span): derive per time.
  const covered =
    isLive ||
    (history !== null &&
      sites.every((s) => {
        const h = history.byLid[s.lid];
        return h !== undefined && reviewAt(h, asOfMs) !== null;
      }));
  const needDerived = !isLive && !covered && !scrubbing;
  useEffect(() => {
    if (!needDerived) return;
    const t = asOfMs!;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const data = await loadBoard(app, sites, t, controller.signal);
        if (controller.signal.aborted) return;
        const reviews: Record<string, SiteReview> = {};
        for (const site of sites) reviews[site.lid] = deriveReview({ site, asOfMs: t, live: false, zone: app.copy.timezone, ...boardInputs(data, site) });
        setDerived({ asOfMs: t, data, reviews });
        setError(null);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      }
    }, ASOF_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [app, sites, asOfMs, needDerived]);

  if (isLive) return { asOfMs: live?.nowMs ?? null, data: live?.data ?? null, reviews: live?.reviews ?? {}, loading: live === null, error };
  if (covered && history) {
    const reviews: Record<string, SiteReview> = {};
    for (const site of sites) {
      // Thresholds the API first stored after the as-of time: held now (the live board), missing then.
      const heldNow = thresholdList(live?.data?.sites[site.lid]?.status?.thresholds).length > 0;
      reviews[site.lid] = withThresholdsLater(reviewAt(history.byLid[site.lid]!, asOfMs)!, heldNow);
    }
    return { asOfMs, data: live?.data ?? null, reviews, loading: false, error };
  }
  const ready = derived && derived.asOfMs === asOfMs;
  return { asOfMs: ready ? asOfMs : null, data: ready ? derived.data : (live?.data ?? null), reviews: ready ? derived.reviews : (derived?.reviews ?? live?.reviews ?? {}), loading: !ready, error };
}

export type SiteDetail = {
  history: SiteHistory | null;
  at: SiteAt | null;
  atMs: number | null;
  /** The status in `at` is the one at the cursor (false while a drag moves the cursor ahead of the last fetch). */
  settled: boolean;
  /** NWPS observations paired to the forecast in force (what happened next) and to the oldest issuance in view. */
  verify: VerifyPoint[];
  error: string | null;
};

/**
 * The selected site: its issuance history and the readings of the span (once per site and minute), the
 * verification pairs of every issuance in the span (once, with the history), and the exact status at the cursor.
 * A scrub answers from those (the forecast in force, readings up to the cursor, pairs of the issuance in force);
 * the status request waits for the scrubber's release, then the as-of to settle.
 */
export function useSiteDetail(site: Site | null, asOfMs: number | undefined, nowMs: number, span: { fromMs: number; toMs: number }, scrubbing = false): SiteDetail {
  const [history, setHistory] = useState<{ lid: string; data: SiteHistory; verify: Record<string, VerifyPoint[]> } | null>(null);
  const [readings, setReadings] = useState<{ lid: string; fromMs: number; data: SiteAt["readings"] } | null>(null);
  const [at, setAt] = useState<{ lid: string; ms: number; data: SiteStatusAt } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lid = site?.lid ?? null;
  const t = asOfMs ?? nowMs;
  const nowKey = Math.floor(nowMs / LIVE_REFRESH_MS);
  const spanFrom = span.fromMs;

  useEffect(() => {
    if (!site) return;
    const controller = new AbortController();
    const run = async () => {
      try {
        const data = await loadSiteHistory(site, nowMs, controller.signal);
        // Every river issuance that can be in force inside the span: their pairs, in a few requests, so a scrub
        // across issuances draws the observations without a request per step.
        const issuances = [...new Set(data.history.filter((s) => isRiverForecast(s) && Date.parse(s.issuedAt) >= spanFrom - 24 * HOUR).map((s) => s.issuedAt))];
        const verify = await loadVerifyMany(site, issuances, controller.signal);
        if (!controller.signal.aborted) setHistory({ lid: site.lid, data, verify });
      } catch (err) {
        if (!controller.signal.aborted) setError(String(err));
      }
    };
    void run();
    return () => controller.abort();
    // The history is "known now"; re-read when the minute rolls over.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowKey stands for nowMs
  }, [site, nowKey, spanFrom]);

  useEffect(() => {
    if (!site) return;
    const controller = new AbortController();
    loadSiteReadings(site, span, controller.signal)
      .then((data) => !controller.signal.aborted && setReadings({ lid: site.lid, fromMs: span.fromMs, data }))
      .catch((err: unknown) => !controller.signal.aborted && setError(String(err)));
    return () => controller.abort();
  }, [site, span]);

  useEffect(() => {
    if (!site || scrubbing) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      loadSiteStatusAt(site, t, controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return;
          setAt({ lid: site.lid, ms: t, data });
          setError(null);
        })
        .catch((err: unknown) => !controller.signal.aborted && setError(String(err)));
    }, asOfMs === undefined ? 0 : ASOF_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [site, t, asOfMs, scrubbing]);

  const hist = history && history.lid === lid ? history.data : null;
  const shown = hist ? forecastAsOf(hist.history, t) : null;
  const oldest = hist?.history.filter((s) => s.source !== "NWS_GRIDPOINT" && Date.parse(s.issuedAt) >= span.fromMs - 24 * HOUR).sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt))[0];
  const shownAt = shown?.issuedAt;
  const oldestAt = oldest?.issuedAt;
  const verify = useMemo(() => {
    const pairs = history && history.lid === lid ? history.verify : {};
    return [...new Set([shownAt, oldestAt].filter((v): v is string => !!v))].flatMap((i) => pairs[i] ?? []);
  }, [history, lid, shownAt, oldestAt]);
  const atHere = at && at.lid === lid ? at : null;
  const readingsHere = readings && readings.lid === lid && readings.fromMs === span.fromMs ? readings.data : null;

  return {
    history: hist,
    at: atHere && readingsHere ? { ...atHere.data, readings: readingsHere } : null,
    atMs: atHere ? atHere.ms : null,
    settled: atHere !== null && atHere.ms === t,
    verify,
    error,
  };
}
