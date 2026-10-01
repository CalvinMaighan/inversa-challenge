"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { getGlobe } from "client/globe/api";
import { boxOf, fitInPane } from "client/globe/fit";
import { MOBILE_QUERY, useIsMobile } from "client/hud/primitives";
import { applyCarpView, endScrub, goLive, scrubAsOf, selectSite, setAsOf } from "client/state/carp";
import { THEME } from "client/state/theme";
import { VIEW, type ViewState } from "client/state/view";
import type { AppConfig } from "shared/apps";

import Board, { type Preset } from "./Board";
import { briefing } from "./briefing";
import CarpTimeline from "./CarpTimeline";
import type { ChartData } from "./chart";
import { yesterdayAfternoon } from "./format";
import {
  earlierIssuances,
  flowConflict,
  forecastAsOf,
  frameSites,
  forecastSeries,
  HOUR,
  issuanceSpread,
  sitesOf,
  stageConflict,
  thresholdList,
  usgsSeries,
  weatherAt,
  type Site,
  type SourceConflict,
} from "./model";
import { deriveReview } from "./review";
import SiteDrawer, { type SiteEvidence } from "./SiteDrawer";
import SiteMarkers from "./SiteMarkers";
import { useBoard, useCarp, useNow, useSiteDetail } from "./use-carp";

/** Chart window: eight days back (replay coverage and a week of stage) to a week ahead (forecast). */
const BACK_MS = 8 * 24 * HOUR;
const AHEAD_MS = 7 * 24 * HOUR;
/** Replay: one hour of as-of time per tick. */
const REPLAY_TICK_MS = 120;
/** Play from live starts this far back. */
const REPLAY_FROM_LIVE_MS = 48 * HOUR;
const SITE_ALTITUDE_M = 45_000;
/** Room around the outer sites on a phone: half a marker plus its id label. */
const MARKER_INSET_PX = 34;

/**
 * Sites framed where the user sees them: fitted to the measured free rect (clear of the board, the timeline and the
 * cards) and, on the stage layout, inside the circle (client/globe/fit.ts). `frameSites`' fixed margins only before
 * the pane is laid out.
 */
function frameFor(sites: readonly Site[], mobile: boolean) {
  return fitInPane(boxOf(sites), MARKER_INSET_PX) ?? frameSites(sites, !mobile);
}

/**
 * The carp HUD (leaf UC): site markers on the globe, the review board, the briefing and evidence drawer, and the
 * stage timeline with the "what we knew" mode. View state lives in CARP (site, asOf, replay); the agent writes
 * the same key.
 */
export default function CarpHud({ app }: { app: AppConfig }) {
  const sites = useMemo(() => sitesOf(app.locations), [app]);
  const carp = useCarp();
  const nowMs = useNow();
  const mobile = useIsMobile();
  const [theme] = useActiveState(THEME);
  const zone = app.copy.timezone;
  const live = carp.asOf === undefined;
  const asOfMs = carp.asOf ?? nowMs;
  const site = sites.find((s) => s.lid === carp.site) ?? null;

  const span = useMemo(() => {
    const now = Math.floor(nowMs / HOUR) * HOUR;
    return { fromMs: now - BACK_MS, toMs: now + AHEAD_MS };
  }, [nowMs]);

  const scrubbing = carp.scrubbing === true;
  const board = useBoard(app, sites, carp.asOf, nowMs, span, scrubbing);
  const detail = useSiteDetail(site, carp.asOf, nowMs, span, scrubbing);

  // Board panel: open on desktop, a tab on phones until asked for.
  const [boardOpen, setBoardOpen] = useState<boolean | null>(null);
  const showBoard = boardOpen ?? !mobile;
  // The preset chip stays lit until a site is chosen (the camera then flies to the site).
  const [presetFor, setPresetFor] = useState<{ id: string; site: string | undefined } | null>(null);
  const preset = presetFor && presetFor.site === carp.site ? presetFor.id : null;

  const presets: Preset[] = useMemo(() => (app.cameraPresets ?? []).map((p) => ({ id: p.id, name: p.name })), [app]);
  const flyPreset = useCallback(
    (id: string) => {
      const p = app.cameraPresets?.find((x) => x.id === id);
      if (!p) return;
      const ids = p.locations?.length ? p.locations : app.locations.map((l) => l.id);
      const chosen = sites.filter((s) => ids.includes(s.id));
      getGlobe()?.flyTo(frameFor(chosen.length ? chosen : sites, mobile));
      setPresetFor({ id, site: carp.site });
    },
    [app, sites, carp.site, mobile],
  );

  // First view: every site in sight, clear of the board and the timeline, unless a link brought its own camera.
  useEffect(() => {
    if (/(^|[#&])c=/.test(window.location.hash)) return;
    // After layout, so a phone's free rect is measured with the timeline and the tab in place.
    const id = requestAnimationFrame(() => {
      const frame = frameFor(sites, window.matchMedia(MOBILE_QUERY).matches);
      set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, ...frame, place: null, seq: prev.seq + 1 }));
    });
    return () => cancelAnimationFrame(id);
    // Once per mount (an app switch remounts).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A newly selected site (board, marker, agent, link): fly there.
  useEffect(() => {
    if (!site) return;
    getGlobe()?.flyTo({ lat: site.lat, lon: site.lon, altitudeM: SITE_ALTITUDE_M, heading: 0, pitch: -90, durationS: 1.2 });
  }, [site]);

  // Replay: advance the as-of time an hour per tick; at now, back to live.
  useEffect(() => {
    if (!carp.replay || carp.asOf === undefined) return;
    const id = setInterval(() => {
      const next = (carp.asOf ?? Date.now()) + HOUR;
      if (next >= Date.now() - 60_000) applyCarpView({ asOf: null, replay: false });
      else applyCarpView({ asOf: next, replay: true });
    }, REPLAY_TICK_MS);
    return () => clearInterval(id);
  }, [carp.replay, carp.asOf]);

  const onPlay = () => {
    if (carp.replay) applyCarpView({ replay: false });
    else applyCarpView({ asOf: carp.asOf ?? Date.now() - REPLAY_FROM_LIVE_MS, replay: true });
  };

  // The selected site, at the cursor.
  const history = useMemo(() => detail.history?.history ?? [], [detail.history]);
  const forecast = useMemo(() => forecastAsOf(history, asOfMs), [history, asOfMs]);
  const earlier = useMemo(() => (forecast ? earlierIssuances(history, forecast, asOfMs) : []), [history, forecast, asOfMs]);
  const usgs = useMemo(() => (site && detail.at ? usgsSeries(detail.at.readings, site) : { stationId: null, stageFt: [], dischargeCfs: [] }), [site, detail.at]);
  const nwpsObserved = useMemo(() => {
    const seen = new Map<number, number>();
    for (const p of detail.verify) if (p.observedAt && typeof p.observedFt === "number") seen.set(Date.parse(p.observedAt), p.observedFt);
    return [...seen].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
  }, [detail.verify]);
  const status = detail.at?.status ?? null;

  const conflicts = useMemo(() => {
    const out: SourceConflict[] = [];
    const obs = status?.observation;
    const known = (pts: typeof usgs.stageFt) => pts.filter((p) => p.t <= asOfMs);
    const nwpsStage = obs && typeof obs.stageFt === "number" ? { t: Date.parse(obs.observedAt), ft: obs.stageFt } : nwpsObserved.filter((p) => p.t <= asOfMs).map((p) => ({ t: p.t, ft: p.v })).at(-1) ?? null;
    const sc = stageConflict(known(usgs.stageFt), nwpsStage);
    if (sc) out.push(sc);
    const fc = flowConflict(known(usgs.dischargeCfs), obs && typeof obs.flowKcfs === "number" ? { t: Date.parse(obs.observedAt), kcfs: obs.flowKcfs } : null);
    if (fc) out.push(fc);
    return out;
  }, [status, usgs, nwpsObserved, asOfMs]);

  const review = site ? (board.reviews[site.lid] ?? null) : null;
  // The drawer's review follows the drawer's own (as-of) data once loaded, so the two never disagree mid-scrub.
  const siteReview = useMemo(() => {
    if (!site || !detail.at) return review;
    const previous = earlier[0] ?? null;
    const thresholdsLater = thresholdList(status?.thresholds).length === 0 && thresholdList(detail.history?.thresholdsNow).length > 0;
    const derived = deriveReview({ site, asOfMs, live, zone, status, forecast, previous, thresholdsLater, usgs: { ...usgs, stageFt: usgs.stageFt.filter((p) => p.t <= asOfMs), dischargeCfs: usgs.dischargeCfs.filter((p) => p.t <= asOfMs) } });
    return review?.origin === "c5" ? review : derived;
  }, [site, detail.at, detail.history, review, asOfMs, live, zone, status, forecast, earlier, usgs]);

  const evidence: SiteEvidence | null = useMemo(() => {
    if (!site) return null;
    const usgsKnown = { ...usgs, stageFt: usgs.stageFt.filter((p) => p.t <= asOfMs), dischargeCfs: usgs.dischargeCfs.filter((p) => p.t <= asOfMs) };
    const weather = detail.at ? weatherAt(detail.at.readings, site, nowMs) : null;
    const alerts = detail.at?.alerts ?? null;
    return {
      site,
      asOfMs,
      live,
      zone,
      review: siteReview,
      briefing: detail.at
        ? briefing({ site, asOfMs, live, zone, status, forecast, previous: earlier[0] ?? null, usgs: usgsKnown, usgsWindow: usgs, alerts, alertsCheckedMs: detail.atMs ?? asOfMs, weather, review: siteReview })
        : null,
      status,
      thresholds: status?.thresholds ?? detail.history?.thresholdsNow ?? null,
      forecast,
      usgs: usgsKnown,
      usgsWindow: usgs,
      alerts,
      conflicts,
      weather,
      // While a drag moves the cursor, the status shown is the last one fetched: said as loading until it settles.
      loading: !detail.at || !detail.settled,
      error: detail.error,
    };
  }, [site, usgs, asOfMs, live, zone, siteReview, detail, status, forecast, earlier, conflicts, nowMs]);

  const coverage = detail.history?.replayCoverageStart ?? (site ? board.data?.sites[site.lid]?.replayCoverageStart : null) ?? Object.values(board.data?.sites ?? {}).map((s) => s.replayCoverageStart).filter(Boolean).sort()[0] ?? null;
  const chart: ChartData = useMemo(() => {
    const thresholds = (status?.thresholds ?? detail.history?.thresholdsNow) ?? null;
    const list = thresholds
      ? (
          [
            ["Action", thresholds.actionFt],
            ["Minor flood", thresholds.minorFt],
            ["Moderate flood", thresholds.moderateFt],
            ["Major flood", thresholds.majorFt],
          ] as const
        )
          .filter(([, v]) => typeof v === "number" && v > -999)
          .map(([label, v]) => ({ label, ft: v as number }))
      : [];
    return {
      fromMs: span.fromMs,
      toMs: span.toMs,
      nowMs,
      cursorMs: asOfMs,
      live,
      zone,
      usgsStage: usgs.stageFt,
      nwpsObserved,
      forecast: forecastSeries(forecast),
      spread: issuanceSpread(forecast, earlier, 3),
      issuedMs: forecast ? Date.parse(forecast.issuedAt) : null,
      horizonMs: forecast ? Date.parse(forecast.horizonEnd ?? forecast.validTo ?? forecast.points.at(-1)?.validAt ?? "") || null : null,
      thresholds: site ? list : [],
      alerts: (detail.at?.alerts ?? []).map((a) => ({ fromMs: Date.parse(a.onset ?? "") || span.fromMs, toMs: Date.parse(a.expires ?? "") || span.toMs, label: a.event })),
      coverageMs: coverage ? Date.parse(coverage) : null,
      message: !site
        ? "Select a location on the map or the board to draw its stage and forecast."
        : detail.error && !detail.at
          ? "Could not load this location's readings; nothing is drawn."
          : !detail.at || !detail.history
            ? `Loading ${site.name}…`
            : usgs.stageFt.length + nwpsObserved.length === 0 && !forecast
              ? "No stage observations or river forecast held for this window."
              : null,
    };
  }, [span, nowMs, asOfMs, live, zone, usgs, nwpsObserved, forecast, earlier, status, detail.history, detail.at, detail.error, site, coverage]);

  return (
    <>
      <SiteMarkers sites={sites} reviews={board.reviews} selected={carp.site} onSelect={(lid) => selectSite(lid)} />
      <Board
        open={showBoard}
        onOpen={() => setBoardOpen(true)}
        onClose={() => setBoardOpen(false)}
        app={app}
        sites={sites}
        reviews={board.reviews}
        selected={carp.site}
        asOfMs={carp.asOf}
        reviewedAtMs={board.asOfMs}
        loading={board.loading}
        error={board.error}
        presets={presets}
        activePreset={preset}
        onPreset={flyPreset}
        onSelect={(lid) => {
          selectSite(lid);
          if (mobile) setBoardOpen(false);
        }}
      />
      <SiteDrawer evidence={evidence} onClose={() => selectSite(null)} />
      <CarpTimeline
        chart={chart}
        siteName={site?.name ?? null}
        forecast={site ? forecast : null}
        conflicts={conflicts}
        replaying={carp.replay === true}
        theme={String(theme ?? "")}
        onScrub={(ms) => (ms >= nowMs - 60_000 ? goLive() : scrubAsOf(ms))}
        onScrubEnd={endScrub}
        onLive={goLive}
        onYesterday={() => setAsOf(yesterdayAfternoon(Date.now(), zone))}
        onPlay={onPlay}
      />
    </>
  );
}
