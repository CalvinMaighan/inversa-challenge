"use client";

import { useCallback, useEffect, useMemo } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { DEFAULT_RANGE_DAYS, RANGE_DAYS } from "client/state/range";
import { TIME, type TimeState } from "client/state/time";

import { fitGlobeInPane, fitInPane } from "client/globe/fit";
import { gateOpen } from "client/intro/gate";
import { MOBILE_QUERY, useIsMobile } from "client/hud/primitives";
import { clearSelection, openEvidence } from "client/hud/selection";
import { LAYERS, type LayersState } from "client/state/layers";
import { SELECTION, type SelectionState } from "client/state/selection";
import { VIEW, type ViewState } from "client/state/view";
import type { AppConfig } from "shared/apps";

import { areaCells, areasOf, frameAreas, cellEvidenceId, countReports, parseCellEvidenceId, snapshotAt, windowReports, type PriorityCell, } from "./model";
import OceanHelp from "./OceanHelp";
import Overlay from "./Overlay";
import PriorityCard from "./PriorityCard";
import { resetView, setSummary, setView, useView, type HelpTopic } from "./store";
import { TOP_CELLS, useCursor, useExplain, useLionfishData } from "./use-lionfish";

/** Room inside the free rect for a report dot or a ranked square at an area edge. */
const AREA_INSET_PX = 22;

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
      if (gateOpen()) return;
      const areas = areasOf(app);
      const box = { west: Math.min(...areas.map((a) => a.bbox.west)), south: Math.min(...areas.map((a) => a.bbox.south)), east: Math.max(...areas.map((a) => a.bbox.east)), north: Math.max(...areas.map((a) => a.bbox.north)) };
      // A load always starts on the whole globe, its edge on the scope circle's, over the areas.
      const centre = { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
      const frame = fitGlobeInPane(centre) ?? fitInPane(box, AREA_INSET_PX) ?? frameAreas(areas, !window.matchMedia(MOBILE_QUERY).matches);
      set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, ...frame, place: null, seq: prev.seq + 1 }));
    });
    return () => cancelAnimationFrame(id);
  }, [app]);

  const reports = useMemo(() => data.reports?.reports ?? [], [data.reports]);
  // The period is the timeline's: one dot per report from its start date to the cursor.
  const fromMs = Date.parse(useActiveState<TimeState, string>(TIME, (t) => t.from)[0] ?? "") || undefined;
  const q = useMemo(() => ({ basis: view.basis, atMs, days: view.days, fromMs, lateOnly: view.lateOnly }), [view.basis, atMs, view.days, fromMs, view.lateOnly]);
  const drawn = useMemo(() => windowReports(reports, { ...q, areaId: view.area }), [reports, q, view.area]);
  const total = useMemo(() => countReports(reports, { ...q, areaId: view.area }), [reports, q, view.area]);
  useEffect(() => setSummary({ independent: data.reports ? total.independent : null, days: view.days, basis: view.basis }), [data.reports, total.independent, view.days, view.basis]);

  // Survey priority at the cursor: the live snapshot, or the newest daily one at or before it.
  const snapshot = useMemo(() => (live ? (data.snapshots.find((s) => s.atMs === data.liveMs) ?? null) : snapshotAt(data.snapshots, atMs)), [live, data.snapshots, data.liveMs, atMs]);
  const mapCells = useMemo(
    () => data.areas.filter((a) => !view.area || a.id === view.area).flatMap((a) => areaCells(snapshot, a.id, TOP_CELLS).map((cell, i) => ({ cell, rank: i + 1 }))),
    [data.areas, view.area, snapshot],
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
  const pickedRank = picked ? (mapCells.find((m) => m.cell.cell === picked.cell)?.rank ?? null) : null;
  const pickedArea = picked ? (data.areas.find((a) => picked.cell.startsWith(`${a.id}:`))?.name ?? "") : "";

  const onHelp = (t: HelpTopic | "all") => setView({ help: t });
  // The ranked survey cells (numbered squares) are not drawn on the map: reports are dots, like carp and python.
  const show = { reports: visible.sightings !== false, heat: view.heat, priority: false, field: view.field && live };

  return (
    <div
      data-testid="lionfish-hud"
      data-ready={data.reports && data.heat && data.feeds && snapshot ? "1" : "0"}
      data-replay-ready={data.replayReady ? "1" : "0"}
      data-live={live ? "1" : "0"}
      style={{ display: "contents" }}
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
      {view.help ? <OceanHelp topic={view.help} onClose={() => setView({ help: null })} /> : null}
    </div>
  );
}
