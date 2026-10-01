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

  /* The species bar wraps to two rows. */
  ${MOBILE} {
    --hud-top: calc(max(var(--gap-s), env(safe-area-inset-top)) + 120px);
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
 * Top row: the species bar on the left, the two icon buttons (About, Theme) pinned top right with room kept for
 * them (78 px plus a gap); on a narrow pane the chips wrap. The row lets the pointer through; its surfaces take
 * it back.
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
  padding-right: 84px;

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
 * HUD over the globe pane, sightings first (PRD §12, T40, T41): the title, LIVE/REPLAY and one status button
 * (feeds, theme, focus, help in its popover) on top, with the species filter bar beside it; the Layers legend
 * top right; hover tooltips over markers; the timeline along the bottom; detection brackets and the scope mask
 * over the globe; the evidence drawer on the right (a bottom sheet on phones). Missions live in the chat
 * column's Missions tab. URL-hash share links keep the view shareable.
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
    </Root>
  );
}
