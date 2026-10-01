"use client";

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import CarpHud from "client/carp/CarpHud";
import LionfishChip from "client/lionfish/LionfishChip";
import LionfishHud from "client/lionfish/LionfishHud";
import { isSurveyApp, parseCellEvidenceId } from "client/lionfish/model";
import { SELECTION } from "client/state/selection";
import styled from "client/styled";

import AppSelect from "./appselect/AppSelect";
import BottomBar from "./shell/BottomBar";
import { useActiveApp } from "./appselect/use-active-app";
import EvidenceDrawer from "./drawer/EvidenceDrawer";
import HelpSheet from "./help/HelpSheet";
import DetectionOverlay from "./overlay/DetectionOverlay";
import { MOBILE } from "./primitives";
import { isDrawerOpen, type HudSelection } from "./selection";
import ShareLinkSync from "./ShareLinkSync";
import SpeciesBar from "./species/SpeciesBar";
import Sync from "./Sync";
import Timeline from "./timeline/Timeline";
import GlobeTooltip from "./tooltip/GlobeTooltip";
import TopBar from "./topbar/TopBar";
import ZoomControls from "./zoom/ZoomControls";

/**
 * Fills the HUD slot of the globe pane. The slot hands pointer events to its direct children; this root gives
 * them back to the globe (`&&` outranks the slot's child rule) and each control surface takes them again, so
 * empty HUD space still drags the camera.
 */
const Root = styled.div`
  position: absolute;
  inset: 0;
  --hud-top: calc(max(var(--gap-s), env(safe-area-inset-top)) + 46px);
  --hud-bottom: calc(max(var(--gap-s), env(safe-area-inset-bottom)) + 96px);
  font-family: var(--font-ui);

  && {
    pointer-events: none;
  }

  ${MOBILE} {
    --hud-bottom: calc(max(var(--gap-s), env(safe-area-inset-bottom)) + 88px);
  }

  /* A conditions app (carp) has the taller stage timeline. */
  &[data-kind="conditions"] {
    --hud-bottom: calc(max(var(--gap-s), env(safe-area-inset-bottom)) + 236px);
    ${MOBILE} {
      --hud-bottom: calc(max(var(--gap-s), env(safe-area-inset-bottom)) + 210px);
    }
  }
`;

/**
 * The HUD's controls, clear of the chat card: on the stage layout the shell sets `--chat-inset` to the card's
 * right edge plus a gutter (0 on phones). Brackets and tooltips stay on the root, which matches the globe
 * canvas pixel for pixel. A size container, so panels size against the room they really have.
 */
const Chrome = styled.div`
  position: absolute;
  inset: 0 0 0 var(--chat-inset, 0px);
  container: globe / size;
`;

/**
 * Top row: the app selector and the species chip on the left, the three icon buttons (About, Theme, Developer)
 * pinned top right with room kept for them (120 px plus a gap); on a narrow pane the row wraps. The row lets the
 * pointer through; its surfaces take it back.
 */
const TopRow = styled.div`
  position: absolute;
  z-index: 4;
  top: max(var(--gap-s), env(safe-area-inset-top));
  left: max(var(--gap-m), env(safe-area-inset-left));
  right: max(var(--gap-m), env(safe-area-inset-right));
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  padding-right: 126px;

  ${MOBILE} {
    left: var(--gap-s);
    right: var(--gap-s);
  }
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
      if (offset > 0) root.style.setProperty("--hud-top", `${Math.ceil(offset + 8)}px`);
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
  const cardOwnsSelection = survey && parseCellEvidenceId(selectedId) !== null;
  return (
    <Root ref={rootRef} data-hud="" data-kind={app.kind} data-drawer-open={drawerOpen ? "" : undefined}>
      {sync && <Sync />}
      <ShareLinkSync />
      <DetectionOverlay focus={focus} layout={`${drawerOpen}:${helpOpen}`} />
      <GlobeTooltip />
      <Chrome data-hud-chrome="">
        <TopRow ref={barRef}>
          <AppSelect />
          {conditions ? null : survey ? <LionfishChip app={app} /> : <SpeciesBar />}
          <TopBar focus={focus} onFocus={setFocus} helpOpen={helpOpen} onHelp={setHelpOpen} />
        </TopRow>
        {/* Carp: sites, review board, briefing drawer and the stage timeline replace the sightings timeline. */}
        {conditions ? <CarpHud key={app.id} app={app} /> : null}
        {survey ? <LionfishHud key={app.id} app={app} /> : null}
        {cardOwnsSelection ? null : <EvidenceDrawer />}
        {conditions ? null : <Timeline />}
        {helpOpen ? <HelpSheet onClose={closeHelp} /> : null}
        {/* GE8: zoom controls (+/-, altitude slider, reset, fit sightings) at the right of the globe. */}
        <ZoomControls />
      </Chrome>
      <BottomBar />
    </Root>
  );
}
