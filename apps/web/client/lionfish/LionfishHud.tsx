"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { DEFAULT_RANGE_DAYS, RANGE_DAYS } from "client/state/range";
import { TIME, type TimeState } from "client/state/time";

import { getGlobe } from "client/globe/api";
import { fitGlobeInPane, fitInPane } from "client/globe/fit";
import { Icon, IconButton, MOBILE, MOBILE_QUERY, Surface, useIsMobile } from "client/hud/primitives";
import { clearSelection, openEvidence } from "client/hud/selection";
import { GUTTER_PX } from "client/hud/shell/geometry";
import { useStageLayout } from "client/hud/shell/StageShell";
import { LAYERS, setLayerVisible, type LayersState } from "client/state/layers";
import { SELECTION, type SelectionState } from "client/state/selection";
import { VIEW, type ViewState } from "client/state/view";
import styled from "client/styled";
import { copyText, LAYER_IDS, type AppConfig } from "shared/apps";

import { areaCells, areaHeat, areasOf, buoyVsSatellite, frameAreas, cellEvidenceId, countReports, isCopy, lagStats, parseCellEvidenceId, snapshotAt, utcText, windowReports, type PriorityCell, type Report } from "./model";
import OceanHelp from "./OceanHelp";
import Overlay from "./Overlay";
import PriorityCard from "./PriorityCard";
import { bannerDismissed, dismissBanner, resetView, setSummary, setView, useView, type HelpTopic } from "./store";
import SurveyPanel, { type AreaRow } from "./SurveyPanel";
import { TOP_CELLS, useCursor, useExplain, useLionfishData } from "./use-lionfish";

const Banner = styled(Surface)`
  position: absolute;
  z-index: 3;
  top: var(--hud-top);
  /* Clear of the survey panel: on its left below 768 px, on its right on the stage layout (GE7). */
  left: calc(max(var(--gap-m), env(safe-area-inset-left)) + var(--lf-panel-l, 0px));
  right: calc(max(var(--gap-m), env(safe-area-inset-right)) + var(--lf-panel-r, 0px));
  max-width: 640px;
  margin: 0 auto;
  display: flex;
  gap: var(--gap-m);
  align-items: flex-start;
  padding: 8px 8px 8px 12px;
  border-left: 3px solid var(--warn);
  border-radius: var(--radius-m);
  font: 400 12.5px / 1.45 var(--font-ui);
  ul {
    flex: 1;
    margin: 0;
    padding-left: 14px;
  }
  ${MOBILE} {
    font-size: 12px;
  }
  &[data-expanded="false"] {
    align-items: center;
    padding-block: 4px;
  }
`;

/** The collapsed banner: every caveat on one line, cut at the edge; pressing it shows them in full. */
const OneLine = styled.button`
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: start;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  b {
    font-weight: 600;
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

/** The banner's chevron: down to expand, up to collapse. */
const Turn = styled.span<{ $up: boolean }>`
  display: inline-flex;
  transform: rotate(${(p) => (p.$up ? -90 : 90)}deg);
`;

const AsOf = styled(Surface)`
  position: absolute;
  z-index: 4;
  left: calc(50% + (var(--lf-panel-l, 0px) - var(--lf-panel-r, 0px)) / 2);
  /* One gutter above the bottom bar (search, Layers: 32 px pills), itself a gutter above the timeline. */
  bottom: calc(var(--hud-bottom) + 32px + var(--gap-m));
  transform: translateX(-50%);
  width: max-content;
  max-width: min(600px, calc(100cqw - 2 * var(--gap-m) - var(--lf-panel-l, 0px) - var(--lf-panel-r, 0px)));
  ${MOBILE} {
    left: 50%;
    max-width: calc(100cqw - 2 * var(--gap-m));
  }
  padding: 6px 12px;
  border: 1px solid color-mix(in oklch, var(--warn) 60%, transparent);
  border-radius: var(--radius-m);
  font: 400 12px / 1.45 var(--font-ui);
  b {
    font-weight: 600;
  }
  small {
    display: block;
    color: var(--muted);
  }
`;

const PANEL_WIDTH = 340;
/** Room inside the free rect for a report dot or a ranked square at an area's edge. */
const AREA_INSET_PX = 22;
const [SIGHTINGS, HOTSPOTS] = LAYER_IDS;

/**
 * Lionfish Watch HUD (leaf UL): area chips, layer toggles, the honesty banner, reports, reef heat, ranked survey
 * cells and the field window over the globe, the priority evidence card, the ocean-data guide and the "known at"
 * label while the shared timeline replays. Everything at the cursor is computed from data loaded at mount.
 */
export default function LionfishHud({ app }: { app: AppConfig }) {
  const species = app.taxa[0]?.id ?? "";
  const view = useView();
  const rangeDays = useActiveState<number>(RANGE_DAYS)[0] ?? DEFAULT_RANGE_DAYS;
  const data = useLionfishData(app, view.field, rangeDays);
  const mobile = useIsMobile();
  const stage = useStageLayout();
  const cursor = useCursor();
  const live = cursor.live;
  const atMs = live ? data.liveMs : Math.min(cursor.atMs, data.liveMs);
  const visible = useActiveState<LayersState, LayersState["visible"]>(LAYERS, (l) => l.visible)[0] ?? LAYERS.defaults.visible;
  const selection = useActiveState<SelectionState>(SELECTION)[0] ?? SELECTION.defaults;
  const picked = selection.drawerOpen !== false ? parseCellEvidenceId(selection.evidenceId) : null;

  // Defaults from the config on mount (an app switch remounts); priority starts on with reports.
  useEffect(() => {
    const on = (id: string) => app.layers.some((l) => l.id === id && l.defaultOn);
    resetView({ heat: on("heat"), field: on("marine") });
  }, [app]);

  // First view: all four areas, clear of the panel and the timeline, unless a link brought its own camera.
  // Fitted to the free rect measured after layout (panel, banner and timeline in place), so no area's markers sit
  // under them or off the edge of a phone; the fixed-margin framing is the fallback.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const areas = areasOf(app);
      const box = { west: Math.min(...areas.map((a) => a.bbox.west)), south: Math.min(...areas.map((a) => a.bbox.south)), east: Math.max(...areas.map((a) => a.bbox.east)), north: Math.max(...areas.map((a) => a.bbox.north)) };
      // A load always starts on the whole globe, its edge on the scope circle's, over the areas.
      const centre = { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
      const frame = fitGlobeInPane(centre) ?? fitInPane(box, AREA_INSET_PX) ?? frameAreas(areas, !window.matchMedia(MOBILE_QUERY).matches);
      set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, ...frame, place: null, seq: prev.seq + 1 }));
    });
    return () => cancelAnimationFrame(id);
  }, [app]);

  const [banner, setBanner] = useState(() => !bannerDismissed(typeof window === "undefined" ? null : window.sessionStorage));
  // In full on a narrow desktop, one line on a phone (three wrapped caveats would take a fifth of the screen) and on
  // the stage layout, where the line sits above the circle between the chat card and the survey panel (GE7); either
  // way the reader can switch.
  const [bannerOpen, setBannerOpen] = useState<boolean | null>(null);
  const bannerFull = bannerOpen ?? (!mobile && !stage);
  const notes = [
    copyText(app, "sightingsNote", "Sightings are not abundance."),
    copyText(app, "heatNote", "Heat stress is context, not proof of damage."),
    copyText(app, "priorityNote", "Survey priority is not a risk or a probability."),
  ];
  const reports = useMemo(() => data.reports?.reports ?? [], [data.reports]);
  // The period is the timeline's: one dot per report from its start date to the cursor.
  const fromMs = Date.parse(useActiveState<TimeState, string>(TIME, (t) => t.from)[0] ?? "") || undefined;
  const q = useMemo(() => ({ basis: view.basis, atMs, days: view.days, fromMs, lateOnly: view.lateOnly }), [view.basis, atMs, view.days, fromMs, view.lateOnly]);
  const drawn = useMemo(() => windowReports(reports, { ...q, areaId: view.area }), [reports, q, view.area]);
  const total = useMemo(() => countReports(reports, { ...q, areaId: view.area }), [reports, q, view.area]);
  const lag = useMemo(() => (data.reports ? lagStats(reports) : null), [data.reports, reports]);
  const areaRows: AreaRow[] = useMemo(
    () =>
      data.areas.map((a) => {
        const mine = reports.filter((r: Report) => r.areaId === a.id && !isCopy(r) && r.observedMs <= atMs);
        return {
          id: a.id,
          name: a.name,
          thin: a.thin,
          count: countReports(reports, { ...q, areaId: a.id }),
          newestObservedMs: mine.length ? Math.max(...mine.map((r) => r.observedMs)) : null,
          heat: areaHeat(data.heat ?? [], a.id, atMs),
        };
      }),
    [data.areas, data.heat, reports, q, atMs],
  );

  useEffect(() => setSummary({ independent: data.reports ? total.independent : null, days: view.days, basis: view.basis }), [data.reports, total.independent, view.days, view.basis]);

  // Survey priority at the cursor: the live snapshot, or the newest daily one at or before it.
  const snapshot = useMemo(() => (live ? (data.snapshots.find((s) => s.atMs === data.liveMs) ?? null) : snapshotAt(data.snapshots, atMs)), [live, data.snapshots, data.liveMs, atMs]);
  const mapCells = useMemo(
    () => data.areas.filter((a) => !view.area || a.id === view.area).flatMap((a) => areaCells(snapshot, a.id, TOP_CELLS).map((cell, i) => ({ cell, rank: i + 1 }))),
    [data.areas, view.area, snapshot],
  );
  const listCells = useMemo(() => (view.area ? mapCells : data.areas.flatMap((a) => areaCells(snapshot, a.id, 2).map((cell, i) => ({ cell, rank: i + 1 })))), [view.area, mapCells, data.areas, snapshot]);

  const florida = data.areas[0]?.id;
  const sstPair = useMemo(() => buoyVsSatellite(data.buoys ?? [], (data.heat ?? []).filter((px) => px.areaId === florida), atMs), [data.buoys, data.heat, florida, atMs]);

  const flyTo = useCallback(
    (id: string | null) => {
      setView({ area: id });
      const a = data.areas.find((x) => x.id === id);
      // The area's box where the user sees it (clear of the cards, inside the stage circle); its configured camera
      // before the pane is laid out.
      if (a) getGlobe()?.flyTo({ ...(fitInPane(a.bbox, AREA_INSET_PX) ?? { lat: a.camera.lat, lon: a.camera.lon, altitudeM: a.camera.heightM, heading: 0, pitch: -90 }), durationS: 1.2 });
      if (mobile) setView({ panelOpen: false });
    },
    [data.areas, mobile],
  );

  const openCell = useCallback(
    (c: PriorityCell) => {
      const t = snapshot?.atMs ?? atMs;
      set<SelectionState>(SELECTION, (prev = SELECTION.defaults) => ({ ...prev, evidenceId: cellEvidenceId(species, c.cell, t), drawerOpen: true }));
      if (mobile) setView({ panelOpen: false });
    },
    [snapshot, atMs, species, mobile],
  );

  const explain = useExplain(species, picked?.cell ?? null, picked?.atMs ?? null);
  const pickedRank = picked ? (mapCells.find((m) => m.cell.cell === picked.cell)?.rank ?? listCells.find((m) => m.cell.cell === picked.cell)?.rank ?? null) : null;
  const pickedArea = picked ? (data.areas.find((a) => picked.cell.startsWith(`${a.id}:`))?.name ?? "") : "";

  const panelOpen = view.panelOpen ?? !mobile;
  // Room the banner and the as-of chip keep for the open survey panel: on the left of the docked layout, on the
  // right of the stage layout, where the panel opens in the right card region (client/hud/Panel.tsx, GE7).
  const panelRoom = panelOpen && !mobile ? `${PANEL_WIDTH + GUTTER_PX}px` : "0px";
  const panelVars = { [stage ? "--lf-panel-r" : "--lf-panel-l"]: panelRoom } as Record<string, string>;
  const onHelp = (t: HelpTopic | "all") => setView({ help: t });
  // The ranked survey cells (numbered squares) are not drawn on the map: reports are dots, like carp and python.
  const show = { reports: visible.sightings !== false, heat: view.heat, priority: false, field: view.field && live };

  return (
    <div
      data-testid="lionfish-hud"
      data-ready={data.reports && data.heat && data.feeds && snapshot ? "1" : "0"}
      data-replay-ready={data.replayReady ? "1" : "0"}
      data-live={live ? "1" : "0"}
      style={{ display: "contents", ...panelVars }}
    >
      <Overlay
        areas={data.areas}
        atMs={atMs}
        reports={data.reports ? drawn : null}
        cells={mapCells}
        reef={view.reef}
        marine={data.marine}
        show={show}
        selectedCell={picked?.cell ?? null}
        onReport={(r) => openEvidence(`sighting:${r.id}`)}
        onCell={openCell}
      />
      {/* The open card repeats these lines; between the panel and the card the banner would be a sliver. */}
      {banner && !(picked && !mobile) ? (
        <Banner
          as="aside"
          role="note"
          aria-label="How to read Lionfish Watch"
          data-testid="lionfish-banner"
          data-hud-obstacle=""
          data-expanded={bannerFull ? "true" : "false"}
          style={{ ...panelVars }}
        >
          {bannerFull ? (
            <ul id="lionfish-banner-notes">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : (
            <OneLine type="button" aria-expanded={false} onClick={() => setBannerOpen(true)} data-testid="lionfish-banner-expand">
              <b>How to read this map:</b> {notes.join(" ")}
            </OneLine>
          )}
          {bannerFull ? (
            <IconButton type="button" aria-label="Collapse to one line" title="Collapse to one line" aria-expanded={true} aria-controls="lionfish-banner-notes" data-testid="lionfish-banner-collapse" onClick={() => setBannerOpen(false)}>
              <Turn $up>
                <Icon name="chevron" />
              </Turn>
            </IconButton>
          ) : null}
          <IconButton
            type="button"
            aria-label="Dismiss for this session"
            title="Dismiss for this session"
            data-testid="lionfish-banner-dismiss"
            onClick={() => {
              dismissBanner(window.sessionStorage);
              setBanner(false);
            }}
          >
            <Icon name="close" />
          </IconButton>
        </Banner>
      ) : null}
      <SurveyPanel
        app={app}
        open={panelOpen}
        onOpen={() => setView({ panelOpen: true })}
        onClose={() => setView({ panelOpen: false })}
        areas={areaRows}
        area={view.area}
        onArea={flyTo}
        layers={{ reports: show.reports, heat: view.heat, priority: show.priority, field: view.field }}
        onLayer={(id, on) => {
          if (id === "reports") setLayerVisible(SIGHTINGS, on);
          else if (id === "priority") setLayerVisible(HOTSPOTS, on);
          else setView({ [id]: on });
        }}
        basis={view.basis}
        onBasis={(basis) => setView({ basis })}
        days={view.days}
        onDays={(days) => setView({ days })}
        lateOnly={view.lateOnly}
        onLateOnly={(lateOnly) => setView({ lateOnly })}
        total={total}
        lag={lag}
        submittedSource={data.reports?.submittedSource ?? null}
        cells={listCells}
        priorityAtMs={snapshot?.atMs ?? null}
        replayReady={data.replayReady}
        selectedCell={picked?.cell ?? null}
        onCell={openCell}
        feeds={data.feeds}
        sstPair={sstPair}
        onHelp={onHelp}
        loading={!data.reports}
        errors={data.errors}
      />
      <PriorityCard
        app={app}
        open={picked !== null}
        rank={pickedRank}
        areaName={pickedArea}
        cell={picked?.cell ?? ""}
        atMs={picked?.atMs ?? atMs}
        live={picked?.atMs === data.liveMs}
        explain={explain.data}
        loading={explain.loading}
        error={explain.error}
        onClose={clearSelection}
        onHelp={onHelp}
      />
      {!live ? (
        <AsOf role="status" data-testid="lionfish-asof" data-asof={atMs}>
          <b>Known at {utcText(atMs)}</b>
          <small>{copyText(app, "replayNote", "Reports submitted by then; priority from what was submitted by then.")}</small>
          <small>
            Priority snapshot {snapshot ? utcText(snapshot.atMs) : "not loaded for this time"}
            {view.field ? " · field window is a forecast from now and is not replayed" : ""}
          </small>
        </AsOf>
      ) : null}
      {view.help ? <OceanHelp topic={view.help} onClose={() => setView({ help: null })} /> : null}
    </div>
  );
}
