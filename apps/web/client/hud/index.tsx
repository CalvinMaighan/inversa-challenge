"use client";

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { SELECTION } from "client/state/selection";
import styled from "client/styled";

import EvidenceDrawer from "./drawer/EvidenceDrawer";
import HelpSheet from "./help/HelpSheet";
import LegendPanel from "./legend/LegendPanel";
import DetectionOverlay from "./overlay/DetectionOverlay";
import { COMPACT_PANE, MOBILE, NARROW_PANE, useIsMobile } from "./primitives";
import { isDrawerOpen, type HudSelection } from "./selection";
import ShareLinkSync from "./ShareLinkSync";
import Sync from "./Sync";
import Timeline from "./timeline/Timeline";
import GlobeTooltip from "./tooltip/GlobeTooltip";
import TopBar from "./topbar/TopBar";

/** Evidence drawer width (client/hud/drawer/EvidenceDrawer), for the legend to sit left of it. */
const DRAWER_PX = 400;

/**
 * Fills the HUD slot of the globe pane. The slot hands pointer events to its direct children; this root gives
 * them back to the globe (`&&` outranks the slot's child rule) and each control surface takes them again, so
 * empty HUD space still drags the camera.
 *
 * `--hud-right` is where right-docked controls (the Layers legend) start: left of the evidence drawer while it
 * is open on a pane wide enough for both, else the pane edge.
 */
const Root = styled.div<{ $drawer: boolean }>`
  position: absolute;
  inset: 0;
  --hud-top: calc(max(var(--gap-s), env(safe-area-inset-top)) + 52px);
  --hud-bottom: calc(max(var(--gap-s), env(safe-area-inset-bottom)) + 112px);
  --hud-right: ${(p) => (p.$drawer ? `calc(min(${DRAWER_PX}px, 100cqw - 2 * var(--gap-m)) + 2 * var(--gap-m))` : "var(--gap-m)")};
  font-family: var(--font-ui);

  && {
    pointer-events: none;
  }

  /* The top bar wraps to two rows (feed chips below the readouts). */
  ${COMPACT_PANE} {
    --hud-top: calc(max(var(--gap-s), env(safe-area-inset-top)) + 84px);
  }

  ${NARROW_PANE} {
    --hud-right: var(--gap-m);
  }

  ${MOBILE} {
    --hud-top: calc(max(var(--gap-s), env(safe-area-inset-top)) + 84px);
    --hud-bottom: calc(max(var(--gap-s), env(safe-area-inset-bottom)) + 104px);
    --hud-right: var(--gap-s);
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
 * Tactical HUD over the globe pane (PRD §12, T40): feed chips, clocks, help and theme on top; the Layers legend
 * top right; hover tooltips over markers; the timeline scrubber along the bottom; detection brackets and the
 * scope mask over the globe; the evidence drawer on the right (a bottom sheet on phones). Missions live in the
 * chat column's Missions tab. URL-hash share links keep the view shareable.
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
  const [legendOpen, setLegendOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const phone = useIsMobile();
  const drawerOpen = useActiveState<HudSelection, boolean>(SELECTION, isDrawerOpen)[0] ?? false;
  // Phones show one sheet at a time: opening the drawer folds the legend away.
  const legendShown = legendOpen && !(phone && drawerOpen);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);

  // Panels start below the top bar, however many rows it wrapped to (one wide, two beside a wide column, three
  // on a phone). The CSS values are the first-paint guess; this measures.
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

  return (
    <Root ref={rootRef} data-hud="" data-drawer-open={drawerOpen ? "" : undefined} $drawer={drawerOpen && !phone}>
      {sync && <Sync />}
      <ShareLinkSync />
      <DetectionOverlay focus={focus} layout={`${drawerOpen}:${legendShown}:${helpOpen}`} />
      <GlobeTooltip />
      <TopBar barRef={barRef} focus={focus} onFocus={setFocus} helpOpen={helpOpen} onHelp={setHelpOpen} />
      <LegendPanel open={legendShown} onOpenChange={setLegendOpen} />
      <EvidenceDrawer />
      <Timeline />
      {helpOpen ? <HelpSheet onClose={closeHelp} /> : null}
    </Root>
  );
}
