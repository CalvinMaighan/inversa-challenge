"use client";

import { Surface } from "client/hud/primitives";
import styled from "client/styled";
import { APP_ICONS, ICON_VIEWBOX } from "shared/app-icons";

import { FISH_COLOR, setFishVisible, useFish } from "./fish";

const Chip = styled(Surface.withComponent("button"))`
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
    color: ${FISH_COLOR};
  }
  &[aria-pressed="false"] svg {
    color: var(--muted);
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

/** The species chip of the carp app, like Python's: the fish, "Carp" and how many sightings are on the map; one tap shows or hides them. */
export default function CarpChip() {
  const { visible, shown, status } = useFish();
  const count = status === "ready" ? String(shown.length) : status === "error" ? "!" : "…";
  return (
    <Chip
      type="button"
      data-testid="carp-chip"
      aria-pressed={visible}
      aria-label={`Asian carp: ${status === "ready" ? `${shown.length} recent sightings on the map` : status === "error" ? "sightings could not be loaded" : "loading sightings"}. ${visible ? "Hide" : "Show"} them`}
      onClick={() => setFishVisible(!visible)}
    >
      <svg viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {APP_ICONS.carp.paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      Carp
      <small>{count}</small>
    </Chip>
  );
}
