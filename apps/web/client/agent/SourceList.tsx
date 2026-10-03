"use client";

import { useState } from "react";

import styled from "client/styled";
import type { AgentCitation } from "client/state/agent";

import type { QuestionIcon } from "shared/apps/question-catalog";

import { QuestionIconView } from "./question-icons";
import type { InfoCard } from "./chat/thread";

/** Which small icon stands for a kind of evidence. */
const ICONS: Record<string, QuestionIcon> = {
  sighting: "species",
  fish: "species",
  reading: "water",
  forecast: "water",
  alert: "hotspot",
  hotspot: "hotspot",
  backtest: "clock",
  fetch: "source",
  source: "source",
  note: "pin",
  message: "pin",
  mission: "pin",
  vessel: "pin",
};

/** What a kind of evidence is called in a sentence. */
const KIND_WORDS: Record<string, string> = {
  sighting: "Sighting",
  fish: "Sighting",
  reading: "Reading",
  forecast: "Forecast",
  alert: "Alert",
  hotspot: "Hotspot score",
  backtest: "Backtest",
  fetch: "Feed check",
  source: "Data source",
  note: "Note",
};

/** `Bighead carp · 2026-08-29 · iNaturalist` is a title and the rest of the line. */
export function splitLabel(label: string): { title: string; meta: string } {
  const [title = label, ...rest] = label.split(" · ");
  return { title, meta: rest.join(" · ") };
}

const Wrap = styled.section`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;

  > header {
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--muted);
    font: 600 10.5px / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  > header span {
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
  }
`;

const List = styled.ol`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Row = styled.button`
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 8px;
  width: 100%;
  padding: 5px 8px 5px 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: color-mix(in oklab, var(--surface-2) 55%, transparent);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;

  .tile {
    position: relative;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: color-mix(in oklab, var(--accent) 16%, transparent);
    color: var(--accent);
    font-size: 14px;
  }
  .tile b {
    position: absolute;
    right: -4px;
    top: -4px;
    display: grid;
    place-items: center;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: var(--accent);
    color: var(--surface);
    font: 700 9px / 1 var(--font-mono);
  }
  .text {
    min-width: 0;
  }
  .title {
    display: block;
    overflow: hidden;
    font: 500 var(--font-xs) / 1.3 var(--font-ui);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .meta {
    display: block;
    overflow: hidden;
    color: var(--muted);
    font: 400 11px / 1.3 var(--font-ui);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .go {
    color: var(--muted);
    font-size: 12px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  &:hover,
  &:focus-visible,
  &[aria-current="true"] {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 10%, var(--surface-2));
  }
  &:hover .go,
  &:focus-visible .go,
  &[aria-current="true"] .go {
    opacity: 1;
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const More = styled.button`
  align-self: flex-start;
  padding: 2px 4px;
  border: 0;
  background: none;
  color: var(--muted);
  font: 500 var(--font-xs) / 1.3 var(--font-ui);
  cursor: pointer;

  &:hover,
  &:focus-visible {
    color: var(--text);
    text-decoration: underline;
  }
`;

const VISIBLE = 4;

/**
 * The evidence behind an answer or a card: one row per source with an icon for its kind, its title, what it is and where it
 * is from; a click opens the record (a sighting on the map, a feed's check in the drawer).
 */
export function SourceList({ items, selected, onCite, label = "Sources" }: { items: readonly AgentCitation[]; selected: string | null; onCite: (id: string) => void; label?: string }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, VISIBLE);
  return (
    <Wrap aria-label={label} data-sources="">
      <header>
        {label} <span>{items.length}</span>
      </header>
      <List>
        {shown.map((c, i) => {
          const { title, meta } = splitLabel(c.label);
          const kind = KIND_WORDS[c.kind] ?? c.kind;
          return (
            <li key={c.id}>
              <Row type="button" title={`${kind}: ${c.label}`} data-evidence-id={c.id} data-kind={c.kind} aria-current={selected === c.id ? "true" : undefined} onClick={() => onCite(c.id)}>
                <span className="tile">
                  <QuestionIconView name={ICONS[c.kind] ?? "source"} />
                  <b>{i + 1}</b>
                </span>
                <span className="text">
                  <span className="title">{title}</span>
                  <span className="meta">{[kind, meta].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="go" aria-hidden="true">
                  ↗
                </span>
              </Row>
            </li>
          );
        })}
      </List>
      {items.length > VISIBLE && !all ? (
        <More type="button" onClick={() => setAll(true)}>
          Show {items.length - VISIBLE} more
        </More>
      ) : null}
    </Wrap>
  );
}

const Card = styled.article`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  border: 1px solid color-mix(in oklab, var(--accent) 40%, var(--border));
  border-left-width: 3px;
  border-radius: var(--radius-m);
  background: color-mix(in oklab, var(--accent) 6%, var(--surface-2));

  .tag {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--accent);
    font: 600 10.5px / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  h3 {
    margin: 0;
    font: 600 var(--font-s) / 1.3 var(--font-ui);
  }
  p {
    margin: 0;
    color: var(--text);
    font: 400 var(--font-s) / 1.5 var(--font-ui);
  }
`;

/** An info card pinned in the chat: a title, a few plain sentences and the sources behind them. */
export function InfoCardView({ card, selected, onCite }: { card: InfoCard; selected: string | null; onCite: (id: string) => void }) {
  return (
    <Card data-info-card="">
      <div className="tag">
        <QuestionIconView name="source" /> Info card
      </div>
      <h3>{card.title}</h3>
      <p>{card.text}</p>
      <SourceList items={card.sources} selected={selected} onCite={onCite} />
    </Card>
  );
}

const Chips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;

  > span {
    flex: 1 1 100%;
    color: var(--muted);
    font: 600 10.5px / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  button {
    max-width: 100%;
    padding: 5px 10px;
    border: 1px solid color-mix(in oklab, var(--accent) 45%, var(--border));
    border-radius: var(--radius-round);
    background: color-mix(in oklab, var(--accent) 8%, transparent);
    color: var(--text);
    font: 500 var(--font-xs) / 1.3 var(--font-ui);
    text-align: left;
    cursor: pointer;
  }
  button:hover:not(:disabled),
  button:focus-visible {
    border-color: var(--accent);
    background: color-mix(in oklab, var(--accent) 18%, transparent);
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
`;

/** Questions to ask next, under the newest answer. */
export function FollowUps({ items, disabled, onAsk }: { items: readonly string[]; disabled: boolean; onAsk: (question: string) => void }) {
  if (items.length === 0) return null;
  return (
    <Chips data-follow-ups="">
      <span>Ask next</span>
      {items.map((q) => (
        <button key={q} type="button" disabled={disabled} onClick={() => onAsk(q)}>
          {q}
        </button>
      ))}
    </Chips>
  );
}
