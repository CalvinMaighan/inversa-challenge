"use client";

import { useEffect, useState } from "react";

import styled from "client/styled";
import { parseSourcePage } from "shared/observation-source";

const Line = styled.p`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 6px 0 0;
  color: var(--muted);
  font: 400 12px / 1.4 var(--font-ui);

  svg {
    flex: none;
    width: 13px;
    height: 13px;
    margin-top: 1px;
  }
`;

const known = new Map<string, string | null>();

/**
 * The place name the source gives a sighting, in small text under its photo, as iNaturalist shows it. Looked up once per
 * record through `/api/place`; nothing shows while it loads, when the source has no name, or for a source we cannot ask.
 */
export default function ObservationPlace({ sourcePageUrl }: { sourcePageUrl: string | null }) {
  const src = parseSourcePage(sourcePageUrl);
  const key = src ? `${src.source}:${src.id}` : null;
  const [loaded, setLoaded] = useState<{ key: string; place: string | null } | null>(null);
  useEffect(() => {
    if (!src || !key || known.has(key)) return;
    let live = true;
    fetch(`/api/place?source=${src.source}&id=${src.id}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ place: string | null }>) : { place: null }))
      .catch(() => ({ place: null }))
      .then(({ place }) => {
        known.set(key, place);
        if (live) setLoaded({ key, place });
      });
    return () => {
      live = false;
    };
  }, [key, src?.source, src?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- src is derived from the same string as key
  const place = key ? (known.get(key) ?? (loaded?.key === key ? loaded.place : null)) : null;
  if (!place) return null;
  return (
    <Line data-testid="evidence-place">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 14s4.5-3.9 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 10.1 8 14 8 14Z" />
        <circle cx="8" cy="6.5" r="1.6" />
      </svg>
      <span>{place}</span>
    </Line>
  );
}
