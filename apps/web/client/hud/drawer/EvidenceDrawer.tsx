"use client";

import { useState } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import ExternalLink from "client/external-link";
import { SELECTION } from "client/state/selection";
import styled from "client/styled";

import Panel from "../Panel";
import { Dot, Icon, IconButton, Mono, Pill, SectionTitle, type Tone } from "../primitives";
import { clearSelection, closeDrawer, isDrawerOpen, openEvidence, type HudSelection } from "../selection";
import { feedChip, formatLag } from "../topbar/feed-chips";
import NoteCard, { AddNoteButton } from "../notes/NoteCard";
import { evidenceBadges, evidenceLocation, loadEvidence, parseBacktestId, parseHotspotId, recordRevisions, type BadgeGroup, type Evidence } from "./evidence";
import { BacktestPanel, ExplainPanel } from "./HotspotPanels";
import JsonTree from "./JsonTree";
import SourcePageLink, { RecordValue } from "./SourcePageLink";
import { useLoad } from "./use-load";

const Section = styled.section`
  margin-bottom: var(--gap-l);
`;

const Meta = styled.dl`
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px var(--gap-m);
  margin: 0;
  font-size: 12px;
  dt {
    color: var(--muted);
    font: 600 10px / 18px var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    line-height: 18px;
  }
  a {
    color: var(--accent);
  }
`;

const Badges = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--gap-s);
`;

const LinkList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  li + li {
    margin-top: 4px;
  }
  button {
    width: 100%;
    display: flex;
    gap: var(--gap-s);
    align-items: baseline;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--text);
    font: 12px / 1.3 var(--font-mono);
    text-align: left;
    cursor: pointer;
    &:hover {
      border-color: var(--accent);
    }
  }
  .rel {
    color: var(--muted);
    min-width: 88px;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.06em;
  }
  .id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const Note = styled.p`
  margin: 0;
  color: var(--muted);
  font-size: 12px;
`;

const BADGE: Record<BadgeGroup, { label: (n: number) => string; tone: Tone }> = {
  duplicate_of: { label: () => "DUPLICATE OF", tone: "warn" },
  duplicates: { label: (n) => `${n} DUPLICATE${n === 1 ? "" : "S"}`, tone: "muted" },
  revisions: { label: (n) => `${n} REVISION${n === 1 ? "" : "S"}`, tone: "warn" },
  conflicts: { label: (n) => `${n} CONFLICT${n === 1 ? "" : "S"}`, tone: "danger" },
};

const utc = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 19).replace("T", " ")}Z` : "—");

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 140 ? `${s.slice(0, 139)}…` : s;
  }
  return String(v);
}

/**
 * Duplicate, revision and conflict badges, the links behind them (each moves the selection), and the
 * record's own revision history (ID flips have no id to link to).
 */
function Links({ evidence }: { evidence: Evidence }) {
  const badges = evidenceBadges(evidence);
  const revisions = recordRevisions(evidence.record);
  if (evidence.links.length === 0 && badges.length === 0) return null;
  return (
    <Section aria-label="Linked records">
      <SectionTitle>Links</SectionTitle>
      <Badges>
        {badges.map(({ group, count }) => (
          <Pill key={group} $tone={BADGE[group].tone} data-badge={group}>
            {BADGE[group].label(count)}
          </Pill>
        ))}
      </Badges>
      {revisions.length > 0 && (
        <Meta style={{ marginBottom: "var(--gap-s)" }} aria-label="Revisions">
          {revisions.map((r, i) => (
            <div key={i} style={{ display: "contents" }}>
              <dt>{r.changedAt ? utc(r.changedAt).slice(5, 16) : "revised"}</dt>
              <dd>
                <Mono>
                  {r.field}: {r.old ?? "—"} → {r.new ?? "—"}
                </Mono>
              </dd>
            </div>
          ))}
        </Meta>
      )}
      <LinkList>
        {evidence.links.map((link) => (
          <li key={`${link.relation}:${link.id}`}>
            <button type="button" onClick={() => openEvidence(link.id)} title={`Open ${link.id}`}>
              <span className="rel">{link.relation.replace(/_/g, " ")}</span>
              <span className="id">{link.id}</span>
              <span className="rel" style={{ minWidth: 0, marginLeft: "auto" }}>
                {link.source}
              </span>
            </button>
          </li>
        ))}
      </LinkList>
    </Section>
  );
}

function Record({ evidence }: { evidence: Evidence }) {
  const feed = evidence.feed ? feedChip(evidence.feed) : null;
  // Revisions are listed with the links.
  const rows = Object.entries(evidence.record).filter(([k]) => k !== "revisions");
  const rawSize = evidence.raw === null ? 0 : JSON.stringify(evidence.raw).length;
  return (
    <>
      <Links evidence={evidence} />
      <Section aria-label="Source">
        <SectionTitle>Source</SectionTitle>
        <Meta>
          <dt>Source</dt>
          <dd>
            {evidence.sourceUrl && /^https?:\/\//.test(evidence.sourceUrl) ? (
              <ExternalLink href={evidence.sourceUrl}>
                {evidence.sourceUrl.replace(/^https?:\/\//, "").slice(0, 60)} <Icon name="external" />
              </ExternalLink>
            ) : evidence.sourceUrl ? (
              <Mono>{evidence.sourceUrl}</Mono>
            ) : (
              "—"
            )}
          </dd>
          <dt>Fetched</dt>
          <dd>
            <Mono>{utc(evidence.fetchedAt)}</Mono>
          </dd>
          <dt>Ingest lag</dt>
          <dd>
            <Mono>{formatLag(evidence.ingestLagSeconds)}</Mono>
          </dd>
          <dt>Feed</dt>
          <dd>
            {feed ? (
              <>
                <Pill $tone={feed.tone} title={feed.title}>
                  <Dot $tone={feed.tone} />
                  {feed.label} {feed.state.toUpperCase()} · {feed.lag}
                </Pill>{" "}
                {evidence.feed?.lastFetchRunId && (
                  <IconButton type="button" onClick={() => openEvidence(`fetch:${evidence.feed!.lastFetchRunId}`)} title="Open the feed's latest fetch run">
                    Last run
                  </IconButton>
                )}
              </>
            ) : (
              "—"
            )}
          </dd>
          {evidence.rawKey && (
            <>
              <dt>Raw key</dt>
              <dd>
                <Mono>{evidence.rawKey}</Mono>
              </dd>
            </>
          )}
        </Meta>
      </Section>
      <Section aria-label="Normalized record">
        <SectionTitle>Record</SectionTitle>
        <Meta>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>
                <RecordValue value={v} text={valueText(v)} />
              </dd>
            </div>
          ))}
        </Meta>
      </Section>
      <Section aria-label="Raw payload">
        <details>
          <summary>
            <SectionTitle as="span">Raw payload {rawSize ? `(${(rawSize / 1024).toFixed(1)} KB)` : "(none)"}</SectionTitle>
          </summary>
          {evidence.raw === null ? <Note>No raw payload archived for this record.</Note> : <JsonTree value={evidence.raw} />}
        </details>
      </Section>
    </>
  );
}

/** "Add note about this sighting" (T43), small and under the id: prefills the Notes composer with its place. */
function SightingNoteAction({ id, evidence }: { id: string; evidence: Evidence }) {
  const at = evidenceLocation(evidence.record);
  if (!at) return null;
  return (
    <Section>
      <AddNoteButton sightingId={id.slice("sighting:".length)} lon={at.lon} lat={at.lat} />
    </Section>
  );
}

/**
 * Evidence drawer (PRD §3 flow 2): opens on `SELECTION.evidenceId` and shows the normalized record, the raw
 * payload as fetched, source link, fetch time, ingest lag, feed state, and duplicate / revision / conflict
 * links. Hotspot evidence adds the explain panel, and the backtest panel is one click from it.
 */
export default function EvidenceDrawer() {
  const [selection] = useActiveState<HudSelection>(SELECTION);
  const open = isDrawerOpen(selection);
  const id = open ? selection!.evidenceId! : null;
  const [backtestFor, setBacktestFor] = useState<string | null>(null);
  const kind = id ? id.slice(0, id.indexOf(":")) : "";
  // Field notes (T43) are not Axum evidence: the card reads the local board, so nothing is requested for them.
  const note = kind === "note" ? id!.slice("note:".length) : null;
  const state = useLoad(note ? null : id, () => loadEvidence(id!));
  const hotspot = id ? parseHotspotId(id) : null;
  const backtest = id ? parseBacktestId(id) : null;
  const showBacktest = hotspot !== null && backtestFor === id;

  return (
    <Panel
      side="right"
      open={open}
      onClose={closeDrawer}
      width={400}
      title={
        <>
          Evidence · <span style={{ color: "var(--text)" }}>{kind}</span>
        </>
      }
      tabLabel="Evidence"
      actions={
        <>
          {state.status === "ready" && <SourcePageLink url={state.data.sourcePageUrl} />}
          <IconButton type="button" onClick={clearSelection} title="Clear selection">
            Clear
          </IconButton>
        </>
      }
      data-testid="hud-drawer"
    >
      <Section>
        <Mono style={{ fontSize: 12, overflowWrap: "anywhere" }} data-testid="hud-drawer-id">
          {id}
        </Mono>
      </Section>
      {note && <NoteCard id={note} />}
      {kind === "sighting" && state.status === "ready" && <SightingNoteAction id={id!} evidence={state.data} />}
      {hotspot && (
        <Section>
          {showBacktest ? (
            <BacktestPanel initialSpecies={hotspot.species} onBack={() => setBacktestFor(null)} />
          ) : (
            <ExplainPanel hotspot={hotspot} onBacktest={() => setBacktestFor(id)} />
          )}
        </Section>
      )}
      {backtest && (
        <Section>
          <BacktestPanel key={id} initialSpecies={backtest.species} initialDays={backtest.days} />
        </Section>
      )}
      {state.status === "loading" && <Note>Loading evidence…</Note>}
      {state.status === "error" && (
        <Note role="alert">
          Could not load {id}: {state.error}{" "}
          <IconButton type="button" onClick={state.retry}>
            Retry
          </IconButton>
        </Note>
      )}
      {state.status === "ready" && <Record evidence={state.data} />}
    </Panel>
  );
}
