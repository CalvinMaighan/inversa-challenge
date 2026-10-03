"use client";

import { Surface } from "client/hud/primitives";
import { SPECIES_IMAGE_URLS } from "client/species-images";
import styled from "client/styled";

import { setFishVisible, useFish } from "./fish";

const Chip = styled(Surface.withComponent("button"))`
  display: inline-flex;
  align-items: center;
  gap: var(--gap-s);
  height: 36px;
  padding: 0 var(--gap-m);
  border-radius: var(--radius-m);
  font: 600 12.5px / 1 var(--font-ui);
  cursor: pointer;

  &[aria-pressed="false"] img {
    opacity: 0.45;
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
      {/* eslint-disable-next-line @next/next/no-img-element -- a small same-origin SVG */}
      <img src={SPECIES_IMAGE_URLS.carp} alt="" width={18} height={18} />
      Carp
      <small>{count}</small>
    </Chip>
  );
}
