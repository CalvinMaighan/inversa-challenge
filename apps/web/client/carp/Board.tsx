"use client";

import styled from "client/styled";
import { copyText, type AppConfig } from "shared/apps";

import Panel from "client/hud/Panel";

import { localTime } from "./format";
import type { Site } from "./model";
import { sortBoard, STATUS_WORDS, type SiteReview } from "./review";
import { FRESHNESS_WORDS, StatusGlyph, STATUS_TONE } from "./StatusGlyph";

const Presets = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--gap-m);
`;

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
  grid-template-columns: 22px 1fr;
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

const Foot = styled.footer`
  margin-top: var(--gap-m);
  padding-top: var(--gap-s);
  border-top: 1px solid var(--border);
  color: var(--muted);
  font: 400 12px / 1.45 var(--font-ui);
  p {
    margin: 0 0 6px;
  }
  strong {
    color: var(--text);
    font-weight: 600;
  }
`;

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

/** The review board's contents: presets, the as-of note, sites by severity with reasons, the boundary notice. */
export function BoardView({ app, sites, reviews, selected, asOfMs, reviewedAtMs, loading, error, presets, activePreset, onPreset, onSelect }: BoardViewProps) {
  const zone = app.copy.timezone;
  const rows = sortBoard(sites.filter((s) => reviews[s.lid]).map((site) => ({ site, review: reviews[site.lid]! })));
  const counts = { review: 0, ok: 0, cannot_assess: 0 };
  for (const r of rows) counts[r.review.status] += 1;
  return (
    <div data-testid="carp-board" data-asof={asOfMs ?? "live"} data-reviewed-at={reviewedAtMs ?? ""} aria-busy={loading}>
      <Presets role="group" aria-label="Camera presets">
        {presets.map((p) => (
          <Chip key={p.id} type="button" $on={activePreset === p.id} aria-pressed={activePreset === p.id} data-carp-preset={p.id} onClick={() => onPreset(p.id)}>
            {p.name}
          </Chip>
        ))}
      </Presets>
      {asOfMs !== undefined ? (
        <AsOf data-testid="carp-board-asof">
          Statuses as known at <strong>{localTime(asOfMs, zone)}</strong>, from what was held then. USGS readings carry no receipt time, so they are placed by observation time.
        </AsOf>
      ) : null}
      {error ? <Empty role="alert">Could not load the board: {error}. Statuses below may be out of date.</Empty> : null}
      {rows.length === 0 ? (
        <Empty>{loading ? "Loading the eight locations…" : "No location data could be loaded."}</Empty>
      ) : (
        <>
          <Empty aria-live="polite" style={{ marginBottom: 8 }} data-testid="carp-board-counts">
            {counts.review} need review · {counts.cannot_assess} cannot be assessed · {counts.ok} no rule fired
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
                    data-carp-row={site.lid}
                    data-status={review.status}
                    onClick={() => onSelect(site.lid)}
                  >
                    <StatusGlyph status={review.status} />
                    <span className="name">
                      {site.name}
                      <small>{site.lid}</small>
                    </span>
                    <span className="status">
                      {STATUS_WORDS[review.status]} · {FRESHNESS_WORDS[review.freshness]}
                    </span>
                    {lines.length ? (
                      <ul>
                        {lines.slice(0, 3).map((r, i) => (
                          <li key={i} className={r.kind} data-rule={r.rule}>
                            {r.text}
                          </li>
                        ))}
                        {lines.length > 3 ? <li className="gap">{lines.length - 3} more in the briefing</li> : null}
                      </ul>
                    ) : (
                      <ul>
                        <li className="gap">No rule fired: stage, forecast, alerts and freshness are within bounds.</li>
                      </ul>
                    )}
                  </Row>
                </li>
              );
            })}
          </List>
        </>
      )}
      <Foot data-testid="carp-boundary">
        <p>
          <strong>Conditions only.</strong> {copyText(app, "boundaryNote", "")}
        </p>
        <p>{app.legend.locations ?? ""}</p>
        <p>{app.score.label}.</p>
      </Foot>
    </div>
  );
}

export type BoardPanelProps = BoardViewProps & { open: boolean; onOpen: () => void; onClose: () => void };

/** The board in the left edge panel (a bottom sheet on phones). */
export default function Board({ open, onOpen, onClose, ...view }: BoardPanelProps) {
  return (
    <Panel side="left" title="Locations to review" tabLabel="Sites" open={open} onOpen={onOpen} onClose={onClose} width={340} data-testid="carp-board-panel">
      <BoardView {...view} />
    </Panel>
  );
}
