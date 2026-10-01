"use client";

import type { ReactNode } from "react";

import styled from "client/styled";

import LayersBar from "../layers/LayersBar";
import LookBar from "../look/LookBar";
import { MOBILE } from "../primitives";

/**
 * The bottom-centre bar (docs/GODS_EYE.md GC1): centred under the stage, just above the timeline. It holds the
 * map's look and layer controls, each a leaf's own component that brings its own button and popover:
 *
 *   Look (presets and scope), GE2: client/hud/look
 *   Layers (sightings, notes, ships, water and weather), GE7: client/hud/layers
 *
 * Each leaf appends its one entry to `ITEMS` and nothing else. The bar draws no surface of its own, so with no
 * entries it shows nothing. Popovers opened from it open upwards (`bottom: calc(100% + 6px)`).
 */
const ITEMS: readonly ReactNode[] = [<LookBar key="look" />, <LayersBar key="layers" />];

const Bar = styled.div`
  position: absolute;
  z-index: 5;
  left: 50%;
  bottom: calc(var(--hud-bottom) + var(--gap-s));
  /* Centred under the stage, but never under the chat card (about 1100 px and narrower, where the card reaches
     close to the centre): its left edge stays right of --chat-inset (GE7). */
  transform: translateX(max(-50%, calc(var(--chat-inset, 0px) - 50vw)));
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;

  & > * {
    pointer-events: auto;
  }

  &:empty {
    display: none;
  }

  ${MOBILE} {
    bottom: calc(var(--hud-bottom) + 6px);
  }
`;

export default function BottomBar() {
  return (
    <Bar data-testid="bottom-bar" data-hud-obstacle="">
      {ITEMS}
    </Bar>
  );
}
