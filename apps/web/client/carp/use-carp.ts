"use client";

import { useEffect, useState } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { CARP, type CarpState } from "client/state/carp";
import type { AppConfig } from "shared/apps";

import { boardInputs, loadBoard, loadC5Board, loadSiteAt, loadSiteHistory, loadVerify, type BoardData, type SiteAt, type SiteHistory } from "./data";
import { forecastAsOf, HOUR, type Site, type VerifyPoint } from "./model";
import { deriveReview, type SiteReview } from "./review";

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

/** The review board at `asOfMs` (live: now, refreshed every minute). Statuses from C5 when served, else derived. */
export function useBoard(app: AppConfig, sites: readonly Site[], asOfMs: number | undefined, nowMs: number): BoardState {
  const [state, setState] = useState<BoardState>({ asOfMs: null, data: null, reviews: {}, loading: true, error: null });
  const live = asOfMs === undefined;
  // Live is the wall clock itself (re-read every minute): a floored "now" would hide what arrived this minute.
  const t = live ? nowMs : asOfMs;
  useEffect(() => {
    const controller = new AbortController();
    const run = async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        const [data, c5] = await Promise.all([loadBoard(app, sites, t, controller.signal), loadC5Board(t, controller.signal)]);
        const reviews: Record<string, SiteReview> = {};
        for (const site of sites) {
          const derived = deriveReview({ site, asOfMs: t, live, zone: app.copy.timezone, ...boardInputs(data, site) });
          const served = c5?.[site.lid];
          reviews[site.lid] = served ? { ...served, freshness: derived.freshness } : derived;
        }
        if (!controller.signal.aborted) setState({ asOfMs: t, data, reviews, loading: false, error: null });
      } catch (err) {
        if (!controller.signal.aborted) setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
      }
    };
    // Live re-reads when `nowMs` ticks (every LIVE_REFRESH_MS); a past time waits for scrubbing to settle.
    const timer = setTimeout(run, live ? 0 : ASOF_DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [app, sites, t, live]);
  return state;
}

export type SiteDetail = {
  history: SiteHistory | null;
  at: SiteAt | null;
  atMs: number | null;
  /** NWPS observations paired to the forecast in force (what happened next) and to the oldest issuance in view. */
  verify: VerifyPoint[];
  error: string | null;
};

/** The selected site's history (once), its as-of view (debounced while scrubbing) and verification pairs. */
export function useSiteDetail(site: Site | null, asOfMs: number | undefined, nowMs: number, span: { fromMs: number; toMs: number }): SiteDetail {
  const [history, setHistory] = useState<{ lid: string; data: SiteHistory } | null>(null);
  const [at, setAt] = useState<{ lid: string; ms: number; data: SiteAt } | null>(null);
  const [verify, setVerify] = useState<{ key: string; points: VerifyPoint[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lid = site?.lid ?? null;
  const t = asOfMs ?? nowMs;
  const nowKey = Math.floor(nowMs / LIVE_REFRESH_MS);

  useEffect(() => {
    if (!site) return;
    const controller = new AbortController();
    loadSiteHistory(site, nowMs, controller.signal)
      .then((data) => !controller.signal.aborted && setHistory({ lid: site.lid, data }))
      .catch((err: unknown) => !controller.signal.aborted && setError(String(err)));
    return () => controller.abort();
    // The history is "known now"; re-read when the minute rolls over in live mode only.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowKey stands for nowMs
  }, [site, nowKey]);

  useEffect(() => {
    if (!site) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      loadSiteAt(site, t, span, controller.signal)
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
  }, [site, t, asOfMs, span]);

  const hist = history && history.lid === lid ? history.data : null;
  const shown = hist ? forecastAsOf(hist.history, t) : null;
  const oldest = hist?.history.filter((s) => s.source !== "NWS_GRIDPOINT" && Date.parse(s.issuedAt) >= span.fromMs - 24 * HOUR).sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt))[0];
  const verifyKey = `${lid}|${shown?.issuedAt ?? ""}|${oldest?.issuedAt ?? ""}`;
  useEffect(() => {
    if (!site || (!shown && !oldest)) return;
    const controller = new AbortController();
    const issuances = [...new Set([shown?.issuedAt, oldest?.issuedAt].filter((v): v is string => !!v))];
    Promise.all(issuances.map((i) => loadVerify(site, i, controller.signal).catch(() => [] as VerifyPoint[])))
      .then((lists) => !controller.signal.aborted && setVerify({ key: verifyKey, points: lists.flat() }))
      .catch(() => {});
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- verifyKey covers site and both issuances
  }, [verifyKey]);

  return {
    history: hist,
    at: at && at.lid === lid ? at.data : null,
    atMs: at && at.lid === lid ? at.ms : null,
    verify: verify && verify.key === verifyKey ? verify.points : [],
    error,
  };
}
