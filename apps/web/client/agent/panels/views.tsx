"use client";

import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { SELECTION, type SelectionState } from "client/state/selection";
import { QUALITY_CODES } from "shared/frames";
import { publisherOf } from "shared/source-pages";
import { useTheme } from "client/styled";
import type {
  BacktestView,
  CellsView,
  ExplainView,
  FeedsView,
  SeriesView,
  TableColumn,
  TableView,
  ToolResultView,
} from "shared/agent/results";

import { openEvidence } from "../chat/effects";
import { hoverEvidence } from "./effects";
import {
  formatCell,
  formatNumber,
  formatTick,
  formatTime,
  linePath,
  nextSort,
  niceTicks,
  readoutAt,
  scaleX,
  scaleY,
  seriesDomain,
  sortRows,
  timeTicks,
  visibleRows,
  type Plot,
  type SortState,
} from "./model";
import {
  Baseline,
  BarList,
  BarRow,
  Chart,
  Chip,
  Chips,
  Day,
  Days,
  Empty,
  Fill,
  Legend,
  PageLink,
  Rationale,
  SortButton,
  Stat,
  Table,
  TableFoot,
  TableScroll,
  TextButton,
  Tone,
  Track,
} from "./panels.styled";

export type ViewProps = { turnId: string; wide: boolean };

type ToneName = "ok" | "warn" | "danger" | "muted";

const [RESEARCH, , CASUAL, CURATED] = QUALITY_CODES;
const TONES: Record<string, ToneName> = {
  [RESEARCH]: "ok",
  [CURATED]: "ok",
  ok: "ok",
  nominal: "ok",
  extreme: "danger",
  severe: "danger",
  down: "danger",
  missing: "danger",
  [CASUAL]: "muted",
  unknown: "muted",
  minor: "muted",
};

/** Quality grades, reading flags, feed states and alert severities, as a colour; anything else warns. */
export function toneOf(value: string): ToneName {
  return TONES[value.toLowerCase()] ?? "warn";
}

/** A panel that closes under the pointer never gets its leave event; stop the globe pulse anyway. */
function useHoverCleanup(turnId: string): void {
  useEffect(() => () => hoverEvidence(turnId, null), [turnId]);
}

function useSelected(): string | null {
  return useActiveState<SelectionState, string | null>(SELECTION, (s) => s?.evidenceId ?? null)[0] ?? null;
}

// ---------------------------------------------------------------- table

/** ↗ to the row's record at its publisher, in a new tab. Its clicks and keys stay off the row (which opens the drawer). */
export function SourcePageIcon({ url }: { url: unknown }) {
  const publisher = publisherOf(url);
  if (!publisher || typeof url !== "string") return null;
  return (
    <PageLink
      href={url}
      aria-label={`Open at ${publisher}`}
      title={`Open at ${publisher} in a new tab`}
      data-source-page=""
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onFocus={(event) => event.stopPropagation()}
    >
      ↗
    </PageLink>
  );
}

export function TablePanel({ view, turnId, wide }: ViewProps & { view: TableView }) {
  useHoverCleanup(turnId);
  const [sort, setSort] = useState<SortState>(null);
  const [showAll, setShowAll] = useState(false);
  const selected = useSelected();
  const sorted = useMemo(() => sortRows(view.rows, view.columns, sort), [view, sort]);
  const { rows, hidden } = visibleRows(sorted, showAll);
  // `sourcePageUrl` is a hidden column (no entry in `columns`): drawn as a leading ↗ when any row has a page, first
  // so it stays in view when the table scrolls sideways.
  const pages = view.rows.some((row) => publisherOf(row.sourcePageUrl));
  if (view.rows.length === 0) return <Empty>No rows in this window.</Empty>;

  const cell = (column: TableColumn, value: TableView["rows"][number][string]) => {
    const text = formatCell(value, column);
    return column.kind === "quality" && typeof value === "string" ? <Tone $tone={toneOf(value)}>{text}</Tone> : text;
  };

  return (
    <>
      <TableScroll
        $maxHeight={wide ? 360 : 220}
        onPointerLeave={() => hoverEvidence(turnId, null)}
        // Chromium leaves a partly visible control where it is on Tab: bring headers and rows fully into the box.
        onFocus={(event) => event.target.scrollIntoView({ block: "nearest", inline: "nearest" })}
      >
        <Table data-table-rows={sorted.length}>
          <thead>
            <tr>
              {pages && (
                <th title="Record page at its publisher, in a new tab">
                  <abbr title="Source page" style={{ display: "block", padding: "4px 6px", textDecoration: "none" }}>
                    ↗
                  </abbr>
                </th>
              )}
              {view.columns.map((column) => {
                const active = sort?.key === column.key;
                return (
                  <th key={column.key} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <SortButton type="button" data-sorted={active ? "" : undefined} onClick={() => setSort((prev) => nextSort(prev, column))}>
                      {column.label}
                      {column.unit && column.unit !== "°" ? ` (${column.unit})` : ""}
                      {active ? (sort!.dir === "asc" ? " ▲" : " ▼") : ""}
                    </SortButton>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.evidenceId}
                tabIndex={0}
                data-evidence-id={row.evidenceId}
                aria-selected={selected === row.evidenceId}
                onClick={() => openEvidence(row.evidenceId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openEvidence(row.evidenceId);
                  }
                }}
                onPointerEnter={() => hoverEvidence(turnId, row.evidenceId)}
                onFocus={() => hoverEvidence(turnId, row.evidenceId)}
                onBlur={() => hoverEvidence(turnId, null)}
                title={`Open evidence ${row.evidenceId}`}
              >
                {pages && (
                  <td data-kind="link">
                    <SourcePageIcon url={row.sourcePageUrl} />
                  </td>
                )}
                {view.columns.map((column) => (
                  <td key={column.key} data-kind={column.kind}>
                    {cell(column, row[column.key] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
      {hidden > 0 || showAll || view.total ? (
        <TableFoot>
          <span>
            {rows.length} of {view.total ?? view.rows.length}
            {view.total && view.total > view.rows.length ? ` (first ${view.rows.length} sent)` : ""}
          </span>
          {hidden > 0 || showAll ? (
            <TextButton type="button" onClick={() => setShowAll((v) => !v)} aria-pressed={showAll}>
              {showAll ? "Show fewer" : `Show all ${sorted.length}`}
            </TextButton>
          ) : null}
        </TableFoot>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- series

function usePalette(): string[] {
  const theme = useTheme();
  return [theme.color.accent, theme.color.ok, theme.color.warn, theme.color.text, theme.color.muted, theme.color.danger, theme.color.hudLine, theme.color.accentHover];
}

export function SeriesPanel({ view, turnId, wide }: ViewProps & { view: SeriesView }) {
  useHoverCleanup(turnId);
  const palette = usePalette();
  const [cursor, setCursor] = useState<number | null>(null);
  const domain = useMemo(() => seriesDomain(view), [view]);
  const plot = useMemo<Plot>(() => ({ width: wide ? 600 : 320, height: wide ? 220 : 150, left: 40, right: 8, top: 14, bottom: 20 }), [wide]);
  const paths = useMemo(() => (domain ? view.series.map((line) => linePath(line.points, domain, plot)) : []), [view, domain, plot]);
  if (!domain) return <Empty>No values in this window.</Empty>;

  const yTicks = niceTicks(domain.v0, domain.v1, wide ? 5 : 4);
  const xTicks = timeTicks(domain.t0, domain.t1, wide ? 6 : 3);
  const span = domain.t1 - domain.t0;
  const readout = cursor === null ? [] : readoutAt(view, cursor);
  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * plot.width;
    const frac = (x - plot.left) / (plot.width - plot.left - plot.right);
    setCursor(frac < 0 || frac > 1 ? null : domain.t0 + frac * span);
  };

  return (
    <>
      <Chart
        viewBox={`0 0 ${plot.width} ${plot.height}`}
        role="img"
        aria-label={`${view.title}, ${view.series.length} lines, ${view.unit}`}
        data-series-lines={view.series.length}
        onPointerMove={onMove}
        onPointerLeave={() => setCursor(null)}
      >
        <text className="tick" x={2} y={9}>
          {view.unit}
        </text>
        {yTicks.map((v) => {
          const y = scaleY(v, domain, plot);
          return (
            <g key={`y${v}`}>
              <line className="grid" x1={plot.left} x2={plot.width - plot.right} y1={y} y2={y} />
              <text className="tick" x={plot.left - 4} y={y + 3} textAnchor="end">
                {formatNumber(v)}
              </text>
            </g>
          );
        })}
        {xTicks.map((t) => {
          const x = scaleX(t, domain, plot);
          return (
            <g key={`x${t}`}>
              <line className="axis" x1={x} x2={x} y1={plot.height - plot.bottom} y2={plot.height - plot.bottom + 3} />
              <text className="tick" x={x} y={plot.height - 6} textAnchor="middle">
                {formatTick(t, span)}
              </text>
            </g>
          );
        })}
        <line className="axis" x1={plot.left} x2={plot.width - plot.right} y1={plot.height - plot.bottom} y2={plot.height - plot.bottom} />
        {paths.map((path, i) => (
          <g key={view.series[i]!.label} data-series-line={view.series[i]!.label}>
            {path.d ? <path d={path.d} fill="none" stroke={palette[i % palette.length]} strokeWidth={1.6} strokeLinejoin="round" /> : null}
            {path.dots.map(([x, y]) => (
              <circle key={`${x},${y}`} cx={x} cy={y} r={2.2} fill={palette[i % palette.length]} />
            ))}
          </g>
        ))}
        {cursor !== null ? (
          <>
            <line className="cursor" x1={scaleX(cursor, domain, plot)} x2={scaleX(cursor, domain, plot)} y1={plot.top} y2={plot.height - plot.bottom} />
            {readout.map((r) => {
              const i = view.series.findIndex((line) => line.label === r.label);
              return <circle key={r.label} cx={scaleX(r.t, domain, plot)} cy={scaleY(r.value, domain, plot)} r={3} fill={palette[i % palette.length]} />;
            })}
          </>
        ) : null}
      </Chart>
      <Legend aria-label="Lines">
        {view.series.map((line, i) => {
          const value = readout.find((r) => r.label === line.label);
          return (
            <li
              key={line.label}
              title={line.evidenceId ? `Open evidence ${line.evidenceId}` : line.label}
              onClick={() => line.evidenceId && openEvidence(line.evidenceId)}
              onPointerEnter={() => line.evidenceId && hoverEvidence(turnId, line.evidenceId)}
              onPointerLeave={() => hoverEvidence(turnId, null)}
            >
              <i style={{ background: palette[i % palette.length] }} />
              <span>{line.label}</span>
              {value ? (
                <b>
                  {formatNumber(value.value)} {view.unit} · {formatTime(new Date(value.t).toISOString())}
                </b>
              ) : null}
            </li>
          );
        })}
      </Legend>
    </>
  );
}

// ---------------------------------------------------------------- cells, explain, backtest, feeds

export function CellsPanel({ view, turnId }: ViewProps & { view: CellsView }) {
  useHoverCleanup(turnId);
  if (view.cells.length === 0) return <Empty>No scored cells here.</Empty>;
  const max = Math.max(...view.cells.map((c) => c.score), 1e-9);
  return (
    <BarList aria-label={view.title} onPointerLeave={() => hoverEvidence(turnId, null)}>
      {view.cells.map((cell, i) => (
        <BarRow
          key={cell.evidenceId}
          role="button"
          tabIndex={0}
          data-evidence-id={cell.evidenceId}
          title={`Fly to cell ${cell.cell} and explain its score`}
          onClick={() => openEvidence(cell.evidenceId)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openEvidence(cell.evidenceId);
            }
          }}
          onPointerEnter={() => hoverEvidence(turnId, cell.evidenceId)}
        >
          <span>
            #{i + 1} {cell.cell}
          </span>
          <Track>
            <Fill style={{ width: `${(cell.score / max) * 100}%` }} />
          </Track>
          <span>{cell.score.toFixed(2)}</span>
        </BarRow>
      ))}
    </BarList>
  );
}

export function ExplainPanel({ view }: ViewProps & { view: ExplainView }) {
  const max = Math.max(1, ...view.terms.map((t) => Math.abs(t.value)));
  return (
    <>
      <Stat>
        Score <b>{view.score.toFixed(2)}</b> · heuristic, not a forecast
      </Stat>
      <BarList aria-label="Score terms">
        {view.terms.map((term) => (
          <BarRow key={term.name}>
            <span>{term.name}</span>
            <Track>
              <Fill style={{ width: `${(Math.abs(term.value) / max) * 100}%` }} />
            </Track>
            <span>{formatNumber(term.value)}</span>
            <Rationale>{term.rationale}</Rationale>
          </BarRow>
        ))}
      </BarList>
    </>
  );
}

export function BacktestPanel({ view }: ViewProps & { view: BacktestView }) {
  const lift = view.baseline > 0 ? view.hitRate / view.baseline : null;
  return (
    <>
      <Stat>
        Hit rate <b>{Math.round(view.hitRate * 100)}%</b> vs baseline <b>{Math.round(view.baseline * 100)}%</b>
        {lift !== null ? ` · ${lift.toFixed(1)}× lift` : ""}
      </Stat>
      <Days role="img" aria-label="Daily hit rate against the baseline">
        {view.perDay.map((day) => {
          const rate = day.sightings > 0 ? day.hits / day.sightings : 0;
          return (
            <Day key={day.day} title={`${day.day.slice(0, 10)}: ${day.hits}/${day.sightings} sightings in the top cells`}>
              <span style={{ height: `${Math.max(rate * 100, day.sightings ? 2 : 0)}%`, opacity: day.sightings ? 1 : 0.3 }} />
            </Day>
          );
        })}
        <Baseline style={{ bottom: `${view.baseline * 100}%` }} />
      </Days>
      <TableFoot>
        <span>{view.perDay[0]?.day.slice(5, 10)}</span>
        <span>dashed: {Math.round(view.baseline * 100)}% baseline</span>
        <span>{view.perDay.at(-1)?.day.slice(5, 10)}</span>
      </TableFoot>
    </>
  );
}

export function FeedsPanel({ view }: ViewProps & { view: FeedsView }) {
  return (
    <Chips aria-label="Feeds">
      {view.feeds.map((feed) => (
        <Chip
          key={feed.source}
          $tone={toneOf(feed.state)}
          title={[feed.state, feed.newestObservedAt ? `newest ${feed.newestObservedAt}` : null, feed.note].filter(Boolean).join(" · ")}
        >
          {feed.source} {feed.state}
        </Chip>
      ))}
    </Chips>
  );
}

export function PanelView({ view, turnId, wide }: ViewProps & { view: ToolResultView }) {
  switch (view.view) {
    case "table":
      return <TablePanel view={view} turnId={turnId} wide={wide} />;
    case "series":
      return <SeriesPanel view={view} turnId={turnId} wide={wide} />;
    case "cells":
      return <CellsPanel view={view} turnId={turnId} wide={wide} />;
    case "explain":
      return <ExplainPanel view={view} turnId={turnId} wide={wide} />;
    case "backtest":
      return <BacktestPanel view={view} turnId={turnId} wide={wide} />;
    case "feeds":
      return <FeedsPanel view={view} turnId={turnId} wide={wide} />;
  }
}
