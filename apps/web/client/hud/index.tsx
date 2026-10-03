"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import CarpFishHud from "client/carp/CarpFishHud";
import FishLegend from "client/carp/FishLegend";
import { fitGlobeInPane } from "client/globe/fit";
import { gateOpen } from "client/intro/gate";
import LionfishChip from "client/lionfish/LionfishChip";
import LionfishHud from "client/lionfish/LionfishHud";
import { isSurveyApp, parseCellEvidenceId } from "client/lionfish/model";
import { SELECTION } from "client/state/selection";
import { VIEW, viewFor, type ViewState } from "client/state/view";
import styled from "client/styled";

import AppSelect from "./appselect/AppSelect";
import BottomBar from "./shell/BottomBar";
import { useActiveApp } from "./appselect/use-active-app";
import EvidenceDrawer from "./drawer/EvidenceDrawer";
import HelpSheet from "./help/HelpSheet";
import DetectionOverlay from "./overlay/DetectionOverlay";
import { MOBILE } from "./primitives";
import { isDrawerOpen, type HudSelection } from "./selection";
import RangeButton from "./range/RangeButton";
import ShareLinkSync from "./ShareLinkSync";
import SpeciesBar from "./species/SpeciesBar";
import Sync from "./Sync";
import Timeline from "./timeline/Timeline";
import GlobeTooltip from "./tooltip/GlobeTooltip";
import { GUTTER_PX } from "./shell/geometry";
import TopBar, { ROUND_PX, TOPBAR_WIDTH_CSS } from "./topbar/TopBar";
import LayerRail from "./layers/LayerRail";
import ZoomControls from "./zoom/ZoomControls";

/**
 * Fills the HUD slot of the globe pane. The slot hands pointer events to its direct children; this root gives
 * them back to the globe (`&&` outranks the slot's child rule) and each control surface takes them again, so
 * empty HUD space still drags the camera.
 */
const Root = styled.div`
  position: absolute;
  inset: 0;
  /* First-paint guesses, measured after (the top row by this root, the timeline by itself): the top row's bottom
     plus a gutter, and the timeline's top plus a gutter, from the pane's bottom. */
  --hud-top: calc(max(var(--gap-m), env(safe-area-inset-top)) + ${ROUND_PX}px + var(--gap-m));
  --hud-bottom: calc(max(var(--gap-m), env(safe-area-inset-bottom)) + 84px + var(--gap-m));
  font-family: var(--font-ui);

  && {
    pointer-events: none;
  }

  /* A conditions app (carp) has the taller stage timeline. */
  &[data-kind="conditions"] {
    --hud-bottom: calc(max(var(--gap-m), env(safe-area-inset-bottom)) + 220px + var(--gap-m));
    ${MOBILE} {
      --hud-bottom: calc(max(var(--gap-m), env(safe-area-inset-bottom)) + 194px + var(--gap-m));
    }
  }
`;

/**
 * The HUD's controls, clear of the chat card: on the stage layout the shell sets `--chat-inset` to the card's
 * right edge (0 on phones), and each control keeps one gutter (`--gap-m`) from this box's edges. Brackets and tooltips stay on the root, which matches the globe
 * canvas pixel for pixel. A size container, so panels size against the room they really have.
 */
const Chrome = styled.div`
  position: absolute;
  inset: 0 0 0 var(--chat-inset, 0px);
  container: globe / size;
`;

/**
 * Top row: the app selector and the species chip on the left, the four icon buttons (About, Theme, Look, Developer)
 * pinned top right with room kept for them (their width plus a gutter); on a narrow pane the row wraps. One gutter
 * from the pane's top and sides and between the controls. The row lets the pointer through; its surfaces take it
 * back.
 */
const TopRow = styled.div`
  position: absolute;
  z-index: 4;
  top: max(var(--gap-m), env(safe-area-inset-top));
  left: max(var(--gap-m), env(safe-area-inset-left));
  right: max(var(--gap-m), env(safe-area-inset-right));
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--gap-m);
  padding-right: calc(${TOPBAR_WIDTH_CSS} + var(--gap-m));
`;

export type HudProps = {
  /**
   * Live data sync: feed envelopes and alert bands through `client/threads/api`. On by default; fixtures turn
   * it off and seed the same stores directly.
   */
  sync?: boolean;
};

const noSubscribe = () => () => {};

/**
 * HUD over the globe pane, sightings first (PRD §12, T40, T41, GODS_EYE GC1): the app selector and species
 * chip on top, three icon buttons top right (About with feeds, focus, help and the expert layers; Theme;
 * Developer); hover tooltips over markers; the timeline along the bottom with the bottom bar (Look, Layers)
 * centred above it; detection brackets and the focus mask over the globe; the evidence card on the right (a
 * bottom sheet on phones). Missions live in the chat card's Notes tab. URL-hash share links keep the view
 * shareable.
 *
 * Renders after hydration only: TIME defaults and the clocks are taken at module load, so server HTML for
 * them would never match the browser's.
 */
export default function Hud(props: HudProps) {
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  return hydrated ? <HudBody {...props} /> : null;
}

function HudBody({ sync = true }: HudProps) {
  const [focus, setFocus] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const drawerOpen = useActiveState<HudSelection, boolean>(SELECTION, isDrawerOpen)[0] ?? false;
  const selectedId = useActiveState<HudSelection, string | null>(SELECTION, (s) => s.evidenceId)[0] ?? null;
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const app = useActiveApp();
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Panels start below the top row, however many rows it wrapped to (one wide, two on a phone or beside a wide
  // column). The CSS values are the first-paint guess; this measures.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const bar = barRef.current;
    if (!root || !bar || typeof ResizeObserver !== "function") return;
    const apply = () => {
      const offset = bar.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
      if (offset > 0) root.style.setProperty("--hud-top", `${offset + GUTTER_PX}px`);
    };
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    observer.observe(root);
    apply();
    return () => observer.disconnect();
  }, []);

  const conditions = app.kind === "conditions";
  // Lionfish Watch: its own layers, chip and priority card; a survey cell id opens that card, not the drawer.
  const survey = isSurveyApp(app);

  // First view of a species app: the whole globe, its edge on the scope circle's, over the app's area (the carp and
  // lionfish HUDs frame their own first view the same way). After layout, so the circle is measured.
  const speciesApp = !conditions && !survey;
  useEffect(() => {
    if (!speciesApp) return;
    const id = requestAnimationFrame(() => {
      if (gateOpen()) return;
      const { lat, lon } = viewFor(app);
      const frame = fitGlobeInPane({ lat, lon });
      if (frame) set<ViewState>(VIEW, (prev = VIEW.defaults) => ({ ...prev, ...frame, place: null, seq: prev.seq + 1 }));
    });
    return () => cancelAnimationFrame(id);
  }, [app, speciesApp]);
  const cardOwnsSelection = survey && parseCellEvidenceId(selectedId) !== null;
  return (
    <Root ref={rootRef} data-hud="" data-kind={app.kind} data-drawer-open={drawerOpen ? "" : undefined}>
      {sync && <Sync />}
      <ShareLinkSync />
      <DetectionOverlay focus={focus} layout={`${drawerOpen}:${helpOpen}`} />
      <GlobeTooltip />
      <Chrome data-hud-chrome="">
        <TopRow ref={barRef} data-testid="hud-toprow">
          <AppSelect />
          {conditions ? <FishLegend /> : survey ? <LionfishChip app={app} /> : <SpeciesBar />}
          <RangeButton />
          <TopBar focus={focus} onFocus={setFocus} helpOpen={helpOpen} onHelp={setHelpOpen} />
        </TopRow>
        {/* Carp: sites, review board, briefing drawer and the stage timeline replace the sightings timeline. */}
        {conditions ? <CarpFishHud key={app.id} /> : null}
        {survey ? <LionfishHud key={app.id} app={app} /> : null}
        {cardOwnsSelection ? null : <EvidenceDrawer />}
        {conditions ? null : <Timeline />}
        {helpOpen ? <HelpSheet onClose={closeHelp} /> : null}
        {/* GE8: zoom controls (+/-, altitude slider, reset, fit sightings) at the right of the globe. */}
        {drawerOpen ? null : <LayerRail />}
        <ZoomControls />
        <BottomBar />
      </Chrome>
    </Root>
  );
}
