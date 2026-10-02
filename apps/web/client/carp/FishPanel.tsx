"use client";

import { useEffect } from "react";

import { Icon, IconButton, Surface } from "client/hud/primitives";
import styled from "client/styled";

import { selectFish, useFish } from "./fish";

const SOURCE_NAMES = { inat: "iNaturalist", gbif: "GBIF", nas: "USGS NAS" } as const;

/** The right-hand panel of one sighting, below the top row and above the zoom controls, like the other apps' evidence drawer. */
const Panel = styled(Surface)`
  position: absolute;
  top: var(--hud-top);
  right: max(var(--gap-m), env(safe-area-inset-right));
  bottom: var(--hud-bottom);
  width: min(340px, calc(100% - 2 * var(--gap-m)));
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: var(--gap-m);
  padding: var(--gap-m);
  border-radius: var(--radius-m);
  overflow-y: auto;
  align-self: start;
  height: fit-content;
  max-height: calc(100% - var(--hud-top) - var(--hud-bottom));
`;

const Head = styled.div`
  display: flex;
  align-items: flex-start;
  gap: var(--gap-s);

  h2 {
    flex: 1;
    margin: 0;
    font: 600 15px / 1.3 var(--font-ui);
  }
  small {
    display: block;
    color: var(--muted);
    font: italic 400 12px / 1.4 var(--font-ui);
  }
`;

const Photo = styled.img`
  width: 100%;
  max-height: 220px;
  object-fit: cover;
  border-radius: var(--radius-s);
  background: color-mix(in oklch, var(--text) 8%, transparent);
`;

const Rows = styled.dl`
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px var(--gap-m);
  margin: 0;
  font: 400 13px / 1.4 var(--font-ui);

  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
`;

const RecordLink = styled.a`
  align-self: flex-start;
  color: var(--accent);
  font: 600 13px / 1.4 var(--font-ui);
`;

const dayLabel = (date: string) => {
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : date;
};

/** The selected sighting's details; Escape or the close button dismisses it. */
export default function FishPanel() {
  const { all, selectedId } = useFish();
  const s = selectedId ? all.find((f) => f.id === selectedId) : undefined;

  useEffect(() => {
    if (!s) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") selectFish(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);

  if (!s) return null;
  return (
    <Panel as="aside" role="complementary" aria-label={`${s.species} sighting`} data-testid="fish-panel">
      <Head>
        <h2>
          {s.species}
          <small>{s.scientificName}</small>
        </h2>
        <IconButton type="button" aria-label="Close" onClick={() => selectFish(null)}>
          <Icon name="close" />
        </IconButton>
      </Head>
      {s.photo ? <Photo src={s.photo} alt={`${s.species}, as reported`} crossOrigin="anonymous" onError={(e) => (e.currentTarget.style.display = "none")} /> : null}
      <Rows>
        <dt>Date</dt>
        <dd>{s.date ? dayLabel(s.date) : "Unknown"}</dd>
        <dt>Source</dt>
        <dd>{SOURCE_NAMES[s.source]}</dd>
        <dt>Location</dt>
        <dd>
          {s.lat.toFixed(4)}°, {s.lon.toFixed(4)}°
        </dd>
      </Rows>
      <RecordLink href={s.url} target="_blank" rel="noopener noreferrer">
        Open the record at {SOURCE_NAMES[s.source]} ↗
      </RecordLink>
    </Panel>
  );
}
