"use client";

import { useState } from "react";

import { SPECIES_IDS } from "shared/voice/ui-tools";

import styled from "client/styled";

import { IconButton, Mono, Pill, SectionTitle } from "../primitives";
import { loadBacktest, loadExplain, type Backtest, type HotspotRef } from "./evidence";
import { useLoad } from "./use-load";

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  th {
    text-align: left;
    color: var(--muted);
    font: 600 10px / 1.2 var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0 6px 4px 0;
  }
  td {
    padding: 5px 6px 5px 0;
    border-top: 1px solid var(--border);
    vertical-align: top;
  }
  td.num {
    font-family: var(--font-mono);
    white-space: nowrap;
  }
`;

const Bar = styled.span<{ $value: number }>`
  display: block;
  height: 3px;
  margin-top: 3px;
  width: ${(p) => Math.round(Math.min(1, Math.max(0, p.$value)) * 100)}%;
  background: var(--accent);
  border-radius: 2px;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  flex-wrap: wrap;
  margin-bottom: var(--gap-s);
`;

const Note = styled.p`
  margin: var(--gap-s) 0 0;
  color: var(--muted);
  font-size: 12px;
`;

const Select = styled.select`
  height: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  font: 600 11px / 1 var(--font-mono);
  option {
    background: var(--surface);
  }
`;

const Status = ({ state, retry }: { state: { status: string; error?: string }; retry: () => void }) =>
  state.status === "loading" ? (
    <Note>Loading…</Note>
  ) : state.status === "error" ? (
    <Note role="alert">
      Failed: {state.error}{" "}
      <IconButton type="button" onClick={retry}>
        Retry
      </IconButton>
    </Note>
  ) : null;

/** Hotspot explain (PRD §8): each term of `density × activity × access`, its value and the rule's rationale. */
export function ExplainPanel({ hotspot, onBacktest }: { hotspot: HotspotRef; onBacktest: () => void }) {
  const state = useLoad(`${hotspot.species}:${hotspot.cell}:${hotspot.at}`, () => loadExplain(hotspot.cell, hotspot.species, hotspot.at));
  return (
    <section aria-label="Hotspot explain" data-testid="hud-explain">
      <SectionTitle>Why this cell</SectionTitle>
      <Row>
        <Pill $tone="warn">HEURISTIC</Pill>
        <Mono>
          {hotspot.species} · cell {hotspot.cell}
        </Mono>
        {state.status === "ready" && <Mono>score {state.data.score.toFixed(3)}</Mono>}
      </Row>
      <Status state={state} retry={state.retry} />
      {state.status === "ready" && (
        <Table>
          <thead>
            <tr>
              <th>Term</th>
              <th>Value</th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            {state.data.terms.map((t) => (
              <tr key={t.name}>
                <td>{t.name}</td>
                <td className="num">
                  {t.value.toFixed(3)}
                  <Bar $value={t.value} />
                </td>
                <td>{t.rationale}</td>
              </tr>
            ))}
            {state.data.terms.length === 0 && (
              <tr>
                <td colSpan={3}>No terms returned for this cell and frame.</td>
              </tr>
            )}
          </tbody>
        </Table>
      )}
      <Row style={{ marginTop: "var(--gap-m)" }}>
        <IconButton type="button" onClick={onBacktest} data-testid="hud-open-backtest">
          Backtest {hotspot.species}
        </IconButton>
      </Row>
    </section>
  );
}

const DAY_CHOICES = [7, 14, 30] as const;

function PerDay({ backtest }: { backtest: Backtest }) {
  const days = backtest.perDay;
  const max = Math.max(1, ...days.map((d) => d.sightings));
  const w = 300;
  const h = 64;
  const bw = days.length ? w / days.length : w;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="Sightings and hits per day">
      {days.map((d, i) => {
        const sh = (d.sightings / max) * (h - 4);
        const hh = (d.hits / max) * (h - 4);
        return (
          <g key={d.day}>
            <title>{`${d.day.slice(0, 10)}: ${d.hits} of ${d.sightings} sightings in the top 10 %`}</title>
            <rect x={i * bw + 1} y={h - sh} width={Math.max(1, bw - 2)} height={sh} fill="var(--border)" />
            <rect x={i * bw + 1} y={h - hh} width={Math.max(1, bw - 2)} height={hh} fill="var(--accent)" />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Backtest (PRD §8): for each day D, the share of D's sightings that fell in the top 10 % of cells scored
 * with data before D, against the 10 % baseline. Shown as measured, even when weak.
 */
export function BacktestPanel({ initialSpecies, initialDays = 14, onBack }: { initialSpecies: string; initialDays?: number; onBack?: () => void }) {
  const [species, setSpecies] = useState(initialSpecies);
  const [days, setDays] = useState<number>(initialDays);
  const state = useLoad(`${species}:${days}`, () => loadBacktest(species, days));
  const lift = state.status === "ready" && state.data.baseline > 0 ? state.data.hitRate / state.data.baseline : null;
  return (
    <section aria-label="Backtest" data-testid="hud-backtest">
      <SectionTitle>Backtest</SectionTitle>
      <Row>
        {onBack && (
          <IconButton type="button" onClick={onBack}>
            ← Explain
          </IconButton>
        )}
        <Select aria-label="Species" value={species} onChange={(e) => setSpecies(e.currentTarget.value)}>
          {SPECIES_IDS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select aria-label="Days" value={days} onChange={(e) => setDays(Number(e.currentTarget.value))}>
          {[...new Set<number>([...DAY_CHOICES, initialDays])].sort((a, b) => a - b).map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </Select>
      </Row>
      <Status state={state} retry={state.retry} />
      {state.status === "ready" && (
        <>
          <Row>
            <Pill $tone={lift !== null && lift > 1 ? "ok" : "warn"}>HIT {(state.data.hitRate * 100).toFixed(1)} %</Pill>
            <Pill $tone="muted">BASELINE {(state.data.baseline * 100).toFixed(1)} %</Pill>
            {lift !== null && <Mono>{lift.toFixed(2)}× baseline</Mono>}
          </Row>
          {state.data.perDay.length > 0 ? <PerDay backtest={state.data} /> : <Note>No scored days in this range.</Note>}
          <Note>Share of each day&apos;s sightings inside the top 10 % of cells, scored with data from before that day.</Note>
        </>
      )}
    </section>
  );
}
