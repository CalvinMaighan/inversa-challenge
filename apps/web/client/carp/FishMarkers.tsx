"use client";

import { useEffect, useRef } from "react";

import { getGlobe, onGlobeReady } from "client/globe/api";
import { STAGE_SCOPE_CSS } from "client/hud/shell/StageShell";
import styled from "client/styled";

import { loadFish, selectFish, speciesColor, useFish } from "./fish";

const SIZE = 18;
const SOURCE_NAMES = { inat: "iNaturalist", gbif: "GBIF", nas: "USGS NAS" } as const;

const Layer = styled.div`
  position: absolute;
  /* Canvas pixels: the HUD chrome this sits in starts right of the chat card (--chat-inset), the globe at 0. */
  inset: 0 0 0 calc(-1 * var(--chat-inset, 0px));
  ${STAGE_SCOPE_CSS}
  overflow: hidden;
  z-index: 1;
  && {
    pointer-events: none;
  }
`;

/** One sighting: a fish, a button that opens its panel on the right, a tooltip with the species, the date and the source. */
const Fish = styled.button`
  position: absolute;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  left: 0;
  top: 0;
  width: ${SIZE}px;
  height: ${SIZE}px;
  margin: ${-SIZE / 2}px 0 0 ${-SIZE / 2}px;
  display: grid;
  place-items: center;
  pointer-events: auto;
  will-change: transform;

  /* A dot in the species' colour, ringed dark so it reads over any imagery. */
  i {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    box-shadow: 0 0 0 1.5px rgb(0 0 0 / 70%), 0 1px 3px rgb(0 0 0 / 60%);
  }
  /* Selected: a halo, and a disc in the species' colour that pulses outward, as on the Inversa site. */
  &[data-selected] {
    z-index: 9;
  }
  &[data-selected] i {
    box-shadow: 0 0 0 1.5px rgb(0 0 0 / 70%), 0 0 0 5px color-mix(in oklch, var(--dot) 35%, transparent);
  }
  &[data-selected]::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 9px;
    height: 9px;
    margin: -4.5px 0 0 -4.5px;
    border-radius: 50%;
    background: var(--dot);
    pointer-events: none;
    @keyframes dot-pulse {
      from {
        transform: scale(1);
        opacity: 0.6;
      }
      to {
        transform: scale(4.2);
        opacity: 0;
      }
    }
    animation: dot-pulse 1.6s ease-out infinite;
    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  }
  &[data-hidden] {
    visibility: hidden;
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .tip {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    transform: translateX(-50%);
    width: max-content;
    max-width: 240px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: color-mix(in oklch, var(--surface) 82%, transparent);
    backdrop-filter: blur(10px) saturate(1.2);
    -webkit-backdrop-filter: blur(10px) saturate(1.2);
    box-shadow: var(--shadow);
    color: var(--text);
    font: 400 12px / 1.4 var(--font-ui);
    visibility: hidden;
    pointer-events: none;
    z-index: 2;
  }
  .tip b {
    display: block;
    font-weight: 600;
  }
  .tip small {
    display: block;
    color: var(--muted);
  }
  /* Each fish is its own stacking context (it is moved with a transform), so the popover can only rise above the
     other fish when the fish itself does. */
  &:hover,
  &:focus-visible {
    z-index: 10;
  }
  &:hover .tip,
  &:focus-visible .tip {
    visibility: visible;
    z-index: 3;
  }
`;

/**
 * The Asian carp sightings on the carp map: a fish per record, placed over its globe point after every render like the location
 * markers, hidden behind the globe and when the Carp chip is off.
 */
export default function FishMarkers() {
  const { shown, visible, selectedId } = useFish();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const shownRef = useRef(shown);
  useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  useEffect(() => {
    loadFish();
  }, []);

  // New markers are placed on the next frame: ask for one when the set changes.
  useEffect(() => {
    getGlobe()?.requestRender();
  }, [shown]);

  useEffect(() => {
    let off = () => {};
    const stopReady = onGlobeReady((api) => {
      off();
      const place = () => {
        for (const s of shownRef.current) {
          const el = refs.current.get(s.id);
          if (!el) continue;
          const p = api.project(s.lon, s.lat);
          if (!p) {
            el.setAttribute("data-hidden", "");
            continue;
          }
          el.removeAttribute("data-hidden");
          el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
        }
      };
      off = api.onPostRender(place);
      place();
      api.requestRender();
    });
    return () => {
      stopReady();
      off();
    };
  }, []);

  // A fish is a DOM element over the globe, so the wheel over it never reached the canvas and zoom stalled under the
  // cursor: hand the wheel on to the globe's canvas (a native, non-passive listener, to cancel the page's own scroll).
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const forward = (e: WheelEvent) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-slot="globe"] canvas');
      if (!canvas) return;
      e.preventDefault();
      canvas.dispatchEvent(new WheelEvent("wheel", e));
    };
    layer.addEventListener("wheel", forward, { passive: false });
    return () => layer.removeEventListener("wheel", forward);
  }, [visible]);

  if (!visible) return null;
  return (
    <Layer ref={layerRef} data-testid="carp-fish" aria-label="Asian carp sightings on the map">
      {shown.map((s) => (
        <Fish
          key={s.id}
          ref={(el) => {
            if (el) refs.current.set(s.id, el);
            else refs.current.delete(s.id);
          }}
          type="button"
          onClick={() => selectFish(s.id)}
          data-hidden=""
          data-selected={s.id === selectedId ? "" : undefined}
          style={{ ["--dot" as string]: speciesColor(s.species) }}
          data-fish={s.id}
          aria-label={`${s.species}, ${s.date ?? "date unknown"}, ${SOURCE_NAMES[s.source]}: open details`}
        >
          <i style={{ background: speciesColor(s.species) }} aria-hidden="true" />
          <span className="tip" role="tooltip" aria-hidden="true">
            <b>{s.species}</b>
            {s.date ?? "Date unknown"}
            <small>{SOURCE_NAMES[s.source]}</small>
          </span>
        </Fish>
      ))}
    </Layer>
  );
}
