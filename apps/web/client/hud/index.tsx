"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { SELECTION } from "client/state/selection";
import styled from "client/styled";

import EvidenceDrawer from "./drawer/EvidenceDrawer";
import DetectionOverlay from "./overlay/DetectionOverlay";
import Panel from "./Panel";
import { MOBILE, useIsMobile } from "./primitives";
import { closeDrawer, isDrawerOpen, type HudSelection } from "./selection";
import ShareLinkSync from "./ShareLinkSync";
import Sync from "./Sync";
import Timeline from "./timeline/Timeline";
import TopBar from "./topbar/TopBar";

/**
 * Fills the HUD slot. The slot hands pointer events to its direct children; this root gives them back to the
 * globe (`&&` outranks the slot's child rule) and each control surface takes them again, so empty HUD space
 * still drags the camera.
 */
const Root = styled.div`
  position: absolute;
  inset: 0;
  --hud-top: calc(max(var(--gap-s), env(safe-area-inset-top)) + 52px);
  --hud-bottom: calc(max(var(--gap-s), env(safe-area-inset-bottom)) + 112px);
  font-family: var(--font-ui);

  && {
    pointer-events: none;
  }

  ${MOBILE} {
    --hud-top: calc(max(var(--gap-s), env(safe-area-inset-top)) + 84px);
    --hud-bottom: calc(max(var(--gap-s), env(safe-area-inset-bottom)) + 104px);
  }
`;

export type HudProps = {
  /** Missions panel content (T21), shown in the collapsible left panel. */
  missions?: ReactNode;
  /**
   * Live data sync: feed envelopes and alert bands through `client/threads/api`. On by default; fixtures turn
   * it off and seed the same stores directly.
   */
  sync?: boolean;
};

const noSubscribe = () => () => {};

/**
 * Tactical HUD over the globe (PRD §12): feed chips, clocks and cursor on top; timeline scrubber along the
 * bottom; detection brackets and the scope mask over the globe; missions on the left; the evidence drawer on
 * the right. Panels turn into bottom sheets on phones. URL-hash share links keep the view shareable.
 *
 * Renders after hydration only: TIME defaults and the clocks are taken at module load, so server HTML for
 * them would never match the browser's.
 */
export default function Hud(props: HudProps) {
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  return hydrated ? <HudBody {...props} /> : null;
}

function HudBody({ missions, sync = true }: HudProps) {
  const [focus, setFocus] = useState(false);
  const phone = useIsMobile();
  const drawerOpen = useActiveState<HudSelection, boolean>(SELECTION, isDrawerOpen)[0] ?? false;
  // null until the user toggles: open on desktop, collapsed on phones.
  const [missionsPref, setMissionsPref] = useState<boolean | null>(null);
  // Phones show one bottom sheet at a time; the evidence drawer takes precedence while open.
  const missionsOpen = (missionsPref ?? !phone) && !(phone && drawerOpen);
  const openMissions = () => {
    setMissionsPref(true);
    if (phone && drawerOpen) closeDrawer();
  };
  return (
    <Root data-hud="">
      {sync && <Sync />}
      <ShareLinkSync />
      <DetectionOverlay focus={focus} layout={`${missionsOpen}:${drawerOpen}`} />
      <TopBar focus={focus} onFocus={setFocus} />
      {missions !== undefined && (
        <Panel
          side="left"
          title="Missions"
          tabLabel="Missions"
          open={missionsOpen}
          onClose={() => setMissionsPref(false)}
          onOpen={openMissions}
          width={340}
          data-testid="hud-missions"
        >
          {missions}
        </Panel>
      )}
      <EvidenceDrawer />
      <Timeline />
    </Root>
  );
}
