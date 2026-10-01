"use client";

import { useEffect, useRef } from "react";

import { onGlobeReady } from "client/globe/api";
import styled from "client/styled";

import type { Site } from "./model";
import { STATUS_WORDS, type SiteReview } from "./review";
import { FRESHNESS_WORDS, FreshnessRing, StatusGlyph } from "./StatusGlyph";

const SIZE = 30;

const Layer = styled.div`
  position: absolute;
  inset: 0;
  overflow: hidden;
  z-index: 1;
  && {
    pointer-events: none;
  }
`;

const Marker = styled.button`
  position: absolute;
  left: 0;
  top: 0;
  width: ${SIZE}px;
  height: ${SIZE}px;
  margin: ${-SIZE / 2}px 0 0 ${-SIZE / 2}px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: color-mix(in oklch, #0b0d12 55%, transparent);
  cursor: pointer;
  pointer-events: auto;
  will-change: transform;

  &[data-hidden] {
    visibility: hidden;
  }
  &[aria-pressed="true"] {
    box-shadow: 0 0 0 3px var(--accent), 0 0 14px var(--hud-glow);
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
    max-width: 260px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface);
    box-shadow: var(--shadow);
    color: var(--text);
    font: 400 12px / 1.4 var(--font-ui);
    text-align: left;
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
  }

  .lid {
    position: absolute;
    top: calc(100% + 2px);
    left: 50%;
    transform: translateX(-50%);
    padding: 0 4px;
    border-radius: 3px;
    background: color-mix(in oklch, #0b0d12 70%, transparent);
    color: #e8edf2;
    font: 600 10px / 14px var(--font-mono);
    letter-spacing: 0.04em;
    pointer-events: none;
  }
`;

export type SiteMarkersProps = {
  sites: readonly Site[];
  reviews: Record<string, SiteReview>;
  selected: string | undefined;
  onSelect: (lid: string) => void;
};

/**
 * The eight locations on the globe: a button per site positioned over its globe point after every render, with
 * status (shape + icon + colour), a freshness ring, its NWPS id and a tooltip. Buttons, so the keyboard reaches
 * them and a screen reader names them; hidden when the point is behind the globe.
 */
export default function SiteMarkers({ sites, reviews, selected, onSelect }: SiteMarkersProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const sitesRef = useRef(sites);
  useEffect(() => {
    sitesRef.current = sites;
  }, [sites]);

  useEffect(() => {
    let off = () => {};
    const stopReady = onGlobeReady((api) => {
      off();
      const place = () => {
        for (const site of sitesRef.current) {
          const el = refs.current.get(site.lid);
          if (!el) continue;
          const p = api.project(site.lon, site.lat);
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

  return (
    <Layer data-testid="carp-markers" aria-label="Locations on the map">
      {sites.map((site) => {
        const review = reviews[site.lid];
        const status = review?.status ?? "cannot_assess";
        const freshness = review?.freshness ?? "MISSING";
        const top = review?.reasons.find((r) => r.kind === "review") ?? review?.reasons[0];
        return (
          <Marker
            key={site.lid}
            ref={(el) => {
              if (el) refs.current.set(site.lid, el);
              else refs.current.delete(site.lid);
            }}
            type="button"
            data-carp-site={site.lid}
            data-status={review ? status : "loading"}
            data-freshness={freshness.toLowerCase()}
            data-hidden=""
            aria-pressed={selected === site.lid}
            aria-label={`${site.name} (${site.lid}): ${review ? STATUS_WORDS[status] : "loading"}, ${FRESHNESS_WORDS[freshness]}`}
            onClick={() => onSelect(site.lid)}
          >
            <FreshnessRing freshness={freshness} size={SIZE} />
            <StatusGlyph status={status} />
            <span className="lid" aria-hidden="true">
              {site.lid}
            </span>
            <span className="tip" role="tooltip" aria-hidden="true">
              <b>{site.name}</b>
              {review ? STATUS_WORDS[status] : "Loading…"}
              {top ? <small>{top.text}</small> : null}
              <small>Freshness: {FRESHNESS_WORDS[freshness]}</small>
            </span>
          </Marker>
        );
      })}
    </Layer>
  );
}
