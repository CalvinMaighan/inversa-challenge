"use client";

import { useActiveState } from "@calvinjs/active-state/react";

import { LAYERS, setLayerVisible, type LayersState } from "client/state/layers";
import styled from "client/styled";
import { hasLayer, LAYER_IDS } from "shared/apps";

import { useActiveApp } from "../appselect/use-active-app";
import { useGlobeStats } from "../legend/useGlobeStats";
import { Surface } from "../primitives";

const VESSELS = LAYER_IDS[9];

/**
 * Ships, one tap: an icon button under the app and species chips on the left (carp and lionfish only), the word
 * "Ships" and, while the layer is on, how many ships it draws, to the right of the icon like "Python 5". It flips
 * the same layer switch as the Layers popover, so the two always agree. Off at first load, like every extra layer.
 */
const Chip = styled(Surface.withComponent("button"))`
  position: absolute;
  z-index: 4;
  top: var(--hud-top);
  left: max(var(--gap-m), env(safe-area-inset-left));
  display: inline-flex;
  align-items: center;
  gap: var(--gap-s);
  height: 36px;
  padding: 0 var(--gap-m);
  border-radius: var(--radius-m);
  font: 600 12.5px / 1 var(--font-ui);
  cursor: pointer;

  svg {
    width: 16px;
    height: 16px;
    color: var(--muted);
  }
  &[aria-pressed="true"] svg {
    color: var(--accent);
  }
  small {
    color: var(--muted);
    font-weight: 500;
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

/** A cargo ship from the side: hull, deck house and a mast. */
function ShipIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 9.5h13l-1.6 3.5H3.1z" />
      <path d="M4 9.5V6.5h5v3M9 6.5l2.5 1.2V9.5M6.5 6.5V4" />
    </svg>
  );
}

/** The chip over plain props (the stores are read by ShipsChip), so it renders anywhere, tests included. */
export function ShipsChipView({ on, count, onToggle }: { on: boolean; count: number | null; onToggle: () => void }) {
  return (
    <Chip
      type="button"
      data-testid="ships-chip"
      aria-pressed={on}
      aria-label={on ? `Ships: ${count ?? "loading"} on the map. Hide ships` : "Ships: show ships on the map"}
      onClick={onToggle}
    >
      <ShipIcon />
      Ships
      {on && count !== null ? <small>{count}</small> : null}
    </Chip>
  );
}

export default function ShipsChip() {
  const app = useActiveApp();
  const available = hasLayer(app, VESSELS);
  const on = (useActiveState<LayersState, boolean>(LAYERS, (l) => l.visible[VESSELS] === true)[0] ?? false) as boolean;
  const stats = useGlobeStats(available && on);
  if (!available) return null;
  const count = on ? (stats?.find((s) => s.id === VESSELS)?.count ?? null) : null;
  return <ShipsChipView on={on} count={count} onToggle={() => setLayerVisible(VESSELS, !on)} />;
}
