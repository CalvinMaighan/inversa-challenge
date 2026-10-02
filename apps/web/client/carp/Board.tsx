"use client";

import styled from "client/styled";
import type { AppConfig } from "shared/apps";

import Panel from "client/hud/Panel";

import { localTime, shortAgo } from "./format";
import type { Site } from "./model";
import { RULE_SHORT, sortBoard, STATUS_WORDS, type SiteReview } from "./review";
import { StatusGlyph, STATUS_TONE } from "./StatusGlyph";

/** When a location's newest data point was made: the derived time, else the newest time its reasons name. */
function dataTimeOf(review: SiteReview): number | null {
  if (review.observedAtMs != null) return review.observedAtMs;
  const times = review.reasons.flatMap((r) => [r.observedAt, r.issuedAt]).map((t) => (t ? Date.parse(t) : Number.NaN)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

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

const Row = styled.button<{ $tone: string; $on: boolean }>`
  width: 100%;
  display: grid;
  grid-template-columns: 44px 22px 1fr;
  gap: 2px 8px;
  padding: 8px;
  border: 1px solid ${(p) => (p.$on ? "var(--accent)" : "var(--border)")};
  border-left: 3px solid ${(p) => p.$tone};
  border-radius: var(--radius-s);
  background: ${(p) => (p.$on ? "color-mix(in oklch, var(--accent) 12%, transparent)" : "transparent")};
  color: var(--text);
  text-align: left;
  cursor: pointer;
  &:hover {
    border-color: var(--hud-line);
    border-left-color: ${(p) => p.$tone};
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  svg {
    grid-row: span 3;
    margin-top: 1px;
  }
  .name {
    font: 600 13px / 1.3 var(--font-ui);
  }
  .name small {
    margin-left: 6px;
    color: var(--muted);
    font: 600 10px / 1 var(--font-mono);
    letter-spacing: 0.04em;
  }
  .status {
    font: 600 11px / 1.3 var(--font-mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  ul {
    margin: 2px 0 0;
    padding-left: 14px;
    color: var(--text);
    font: 400 12px / 1.4 var(--font-ui);
  }
  li.gap {
    color: var(--muted);
  }
`;

/** A satellite thumbnail of the location (Esri World Imagery, a small export around its coordinates). */
const Thumb = styled.img`
  grid-row: span 3;
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

const Empty = styled.p`
  margin: 0;
  color: var(--muted);
  font: 400 13px / 1.4 var(--font-ui);
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

/** The locations list: one row per location with its status icon, its newest data age and the one or two reasons that matter. */
export function BoardView({ app, sites, reviews, selected, asOfMs, reviewedAtMs, loading, error, onSelect }: BoardViewProps) {
  const zone = app.copy.timezone;
  const nowMs = asOfMs ?? reviewedAtMs ?? 0;
  const rows = sortBoard(sites.filter((s) => reviews[s.lid]).map((site) => ({ site, review: reviews[site.lid]! })));
  const counts = { review: 0, ok: 0, cannot_assess: 0 };
  for (const r of rows) counts[r.review.status] += 1;
  return (
    <div data-testid="carp-board" data-asof={asOfMs ?? "live"} data-reviewed-at={reviewedAtMs ?? ""} aria-busy={loading}>
      {asOfMs !== undefined ? (
        <AsOf data-testid="carp-board-asof">
          Statuses as known at <strong>{localTime(asOfMs, zone)}</strong>
        </AsOf>
      ) : null}
      {error ? <Empty role="alert">Could not load the locations: {error}. What is shown may be out of date.</Empty> : null}
      {rows.length === 0 ? (
        <Empty>{loading ? "Loading locations…" : "No location data could be loaded."}</Empty>
      ) : (
        <>
          <Empty aria-live="polite" style={{ marginBottom: 8 }} data-testid="carp-board-counts">
            {counts.review} need review · {counts.cannot_assess} no data · {counts.ok} fine
          </Empty>
          <List>
            {rows.map(({ site, review }) => {
              const lines = review.reasons.filter((r) => r.kind !== "info");
              return (
                <li key={site.lid}>
                  <Row
                    type="button"
                    $tone={STATUS_TONE[review.status]}
                    $on={selected === site.lid}
                    aria-pressed={selected === site.lid}
                    aria-label={`${site.name}: ${STATUS_WORDS[review.status]}, ${shortAgo(dataTimeOf(review), nowMs)}`}
                    data-carp-row={site.lid}
                    data-status={review.status}
                    onClick={() => onSelect(site.lid)}
                  >
                    <Thumb src={thumbUrl(site.lat, site.lon)} alt="" loading="lazy" crossOrigin="anonymous" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                    <StatusGlyph status={review.status} />
                    <span className="name">
                      {site.name}
                      <small>{site.lid}</small>
                    </span>
                    <span className="status">{shortAgo(dataTimeOf(review), nowMs)}</span>
                    {lines.length ? (
                      <ul>
                        {lines.slice(0, 2).map((r, i) => (
                          <li key={i} className={r.kind} data-rule={r.rule}>
                            {RULE_SHORT[r.rule] ?? r.rule}
                          </li>
                        ))}
                        {lines.length > 2 ? <li className="gap">+{lines.length - 2} more</li> : null}
                      </ul>
                    ) : null}
                  </Row>
                </li>
              );
            })}
          </List>
        </>
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
