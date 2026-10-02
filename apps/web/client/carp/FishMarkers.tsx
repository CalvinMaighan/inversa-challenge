"use client";

import { useEffect, useRef } from "react";

import { getGlobe, onGlobeReady } from "client/globe/api";
import { STAGE_SCOPE_CSS } from "client/hud/shell/StageShell";
import styled from "client/styled";
import { APP_ICONS, ICON_VIEWBOX } from "shared/app-icons";

import { FISH_COLOR, fishOpacity, loadFish, useFish } from "./fish";

const SIZE = 22;
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

/** One sighting: a fish in a dark disc, a link to the record (new tab), a tooltip with the species, the date and the source. */
const Fish = styled.a`
  position: absolute;
  left: 0;
  top: 0;
  width: ${SIZE}px;
  height: ${SIZE}px;
  margin: ${-SIZE / 2}px 0 0 ${-SIZE / 2}px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in oklch, #0b0d12 70%, transparent);
  box-shadow: 0 0 0 1.5px ${FISH_COLOR};
  color: ${FISH_COLOR};
  pointer-events: auto;
  will-change: transform;

  svg {
    width: 14px;
    height: 14px;
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
    background: var(--surface);
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
  &:hover .tip,
  &:focus-visible .tip {
    visibility: visible;
    z-index: 3;
  }
`;

const FISH_ICON = (
  <svg viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {APP_ICONS.carp.paths.map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
);

/**
 * The Asian carp sightings on the carp map: a fish per record, placed over its globe point after every render like the location
 * markers, hidden behind the globe and when the Carp chip is off.
 */
export default function FishMarkers() {
  const { shown, visible, atMs } = useFish();
  const refs = useRef(new Map<string, HTMLAnchorElement>());
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

  if (!visible) return null;
  return (
    <Layer data-testid="carp-fish" aria-label="Asian carp sightings on the map">
      {shown.map((s) => (
        <Fish
          key={s.id}
          ref={(el) => {
            if (el) refs.current.set(s.id, el);
            else refs.current.delete(s.id);
          }}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          data-hidden=""
          style={{ opacity: s.date ? (fishOpacity(Date.parse(s.date), atMs) ?? 0) : 0 }}
          data-fish={s.id}
          aria-label={`${s.species}, ${s.date ?? "date unknown"}, ${SOURCE_NAMES[s.source]} (opens in a new tab)`}
        >
          {FISH_ICON}
          <span className="tip" role="tooltip" aria-hidden="true">
            <b>{s.species}</b>
            {s.date ?? "Date unknown"}
            <small>{SOURCE_NAMES[s.source]}, opens in a new tab</small>
          </span>
        </Fish>
      ))}
    </Layer>
  );
}
