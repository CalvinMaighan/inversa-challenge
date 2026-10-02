"use client";

import styled from "client/styled";
import type { AppConfig } from "shared/apps";

import Panel from "client/hud/Panel";

import { localTime } from "./format";
import type { SiteReview } from "./review";
import type { Site } from "./model";


export const Chip = styled.button<{ $on?: boolean }>`
  height: 28px;
  padding: 0 10px;
  border: 1px solid ${(p) => (p.$on ? "var(--accent)" : "var(--border)")};
  border-radius: var(--radius-round);
  background: ${(p) => (p.$on ? "color-mix(in oklch, var(--accent) 18%, transparent)" : "transparent")};
  color: var(--text);
  font: 600 12px / 1 var(--font-ui);
  cursor: pointer;
  &:hover {
    border-color: var(--hud-line);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

const AsOf = styled.p`
  margin: 0 0 var(--gap-s);
  padding: 6px 8px;
  border: 1px dashed color-mix(in oklch, var(--warn) 70%, transparent);
  border-radius: var(--radius-s);
  background: color-mix(in oklch, var(--warn) 10%, transparent);
  font: 500 12px / 1.4 var(--font-ui);
`;

const List = styled.ol`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const Empty = styled.p`
  margin: 0;
  color: var(--muted);
  font: 400 13px / 1.4 var(--font-ui);
`;

/** A satellite thumbnail of the location (Esri World Imagery, a small export around its coordinates). */
const Thumb = styled.img`
  width: 44px;
  height: 44px;
  border-radius: var(--radius-s);
  object-fit: cover;
  background: var(--surface-2, transparent);
`;

/** Esri's keyless export of the imagery around a point, 96 px, about 4 km across. */
export function thumbUrl(lat: number, lon: number): string {
  const d = 0.02;
  return `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${lon - d},${lat - d},${lon + d},${lat + d}&bboxSR=4326&imageSR=4326&size=96,96&format=jpg&f=image`;
}

const Row = styled.button<{ $on: boolean }>`
  width: 100%;
  display: grid;
  grid-template-columns: 44px 1fr;
  align-items: center;
  gap: 0 var(--gap-m);
  padding: var(--gap-s);
  border: 0;
  border-radius: var(--radius-s);
  /* Selected: a lighter, still transparent background and the shadow; no border. */
  background: ${(p) => (p.$on ? "color-mix(in oklch, var(--text) 10%, transparent)" : "transparent")};
  box-shadow: ${(p) => (p.$on ? "var(--shadow)" : "none")};
  color: var(--text);
  text-align: left;
  cursor: pointer;
  &:hover {
    background: color-mix(in oklch, var(--text) 7%, transparent);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .name {
    font: 600 13px / 1.3 var(--font-ui);
  }
  .name small {
    display: block;
    margin-top: 2px;
    color: var(--muted);
    font: 600 10px / 1 var(--font-mono);
    letter-spacing: 0.04em;
  }
`;

export type Preset = { id: string; name: string };

export type BoardViewProps = {
  app: AppConfig;
  sites: readonly Site[];
  reviews: Record<string, SiteReview>;
  selected: string | undefined;
  asOfMs: number | undefined;
  /** When the reviews were computed for (null while the first load runs). */
  reviewedAtMs: number | null;
  loading: boolean;
  error: string | null;
  presets: readonly Preset[];
  activePreset: string | null;
  onPreset: (id: string) => void;
  onSelect: (lid: string) => void;
};

/** The locations list: one row per location, its satellite image, its name and its id. */
export function BoardView({ app, sites, reviews, selected, asOfMs, reviewedAtMs, loading, error, onSelect }: BoardViewProps) {
  const zone = app.copy.timezone;
  return (
    <div data-testid="carp-board" data-asof={asOfMs ?? "live"} data-reviewed-at={reviewedAtMs ?? ""} aria-busy={loading}>
      {asOfMs !== undefined ? (
        <AsOf data-testid="carp-board-asof">
          Statuses as known at <strong>{localTime(asOfMs, zone)}</strong>
        </AsOf>
      ) : null}
      {error ? <Empty role="alert">Could not load the locations: {error}.</Empty> : null}
      {sites.length === 0 ? (
        <Empty>{loading ? "Loading locations…" : "No location data could be loaded."}</Empty>
      ) : (
        <List>
          {sites.map((site) => (
            <li key={site.lid}>
              <Row
                type="button"
                $on={selected === site.lid}
                aria-pressed={selected === site.lid}
                aria-label={`${site.name} (${site.lid})`}
                data-carp-row={site.lid}
                data-status={reviews[site.lid]?.status ?? "loading"}
                onClick={() => onSelect(site.lid)}
              >
                <Thumb src={thumbUrl(site.lat, site.lon)} alt="" loading="lazy" crossOrigin="anonymous" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                <span className="name">
                  {site.name}
                  <small>{site.lid}</small>
                </span>
              </Row>
            </li>
          ))}
        </List>
      )}
    </div>
  );
}

export type BoardPanelProps = BoardViewProps & { open: boolean; onOpen: () => void; onClose: () => void };

/** The board in the left edge panel (a bottom sheet on phones). */
export default function Board({ open, onOpen, onClose, ...view }: BoardPanelProps) {
  return (
    <Panel side="left" title={`All locations for ${view.app.name.split(" ")[0]}`} tabLabel="Locations" open={open} onOpen={onOpen} onClose={onClose} width={340} data-testid="carp-board-panel">
      <BoardView {...view} />
    </Panel>
  );
}
