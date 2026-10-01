"use client";

import { useState } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import ExternalLink from "client/external-link";
import CachedImage from "client/media/CachedImage";
import { SELECTION } from "client/state/selection";
import { TIME, type TimeState } from "client/state/time";
import styled from "client/styled";

import Panel from "../Panel";
import { Dot, Icon, IconButton, Mono, Pill, SectionTitle, type Tone } from "../primitives";
import { clearSelection, closeDrawer, isDrawerOpen, openEvidence, type HudSelection } from "../selection";
import { feedChip, formatLag } from "../topbar/feed-chips";
import NoteCard, { AddNoteButton } from "../notes/NoteCard";
import AppIcon from "../appselect/AppIcon";
import {
  evidenceBadges,
  evidenceLocation,
  loadEvidence,
  parseBacktestId,
  parseHotspotId,
  qualityBadges,
  recordRevisions,
  type BadgeGroup,
  type Evidence,
  type QualityBadge,
} from "./evidence";
import { BacktestPanel, ExplainPanel } from "./HotspotPanels";
import JsonTree from "./JsonTree";
import { plainSummary } from "./summary";
import SourcePageLink, { RecordValue } from "./SourcePageLink";
import { useLoad } from "./use-load";
import { CARD_MAX_WIDTH_CSS, STAGE_MEDIA } from "../shell/geometry";
import NearbyAccess from "../search/NearbyAccess";

/** The drawer is the sighting card at the right of the stage (GODS_EYE GC1): its inner edge never reaches the stage centre. */
const CardScope = styled.div`
  display: contents;

  ${STAGE_MEDIA} {
    & > section {
      max-width: ${CARD_MAX_WIDTH_CSS};
    }
  }
`;

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

/** A data-quality flag in the plain summary: a toned chip in UI type that wraps, unlike the technical pills. */
const Flag = styled(Pill)`
  height: auto;
  min-height: 22px;
  padding: 3px 8px;
  white-space: normal;
  font: 500 12px / 1.35 var(--font-ui);
  letter-spacing: normal;
`;

const QUALITY_TONE: Record<QualityBadge["badge"], Tone> = { late: "warn", missing: "muted", failed: "danger", feed: "warn", duplicate: "muted", conflict: "danger" };
const FEED_TONE: Record<string, Tone> = { lagging: "warn", stale: "stale", down: "danger" };

/** PRD §7 in plain words, right under the summary: late, no reading, failed check, duplicate, disagreement, feed. */
function QualityBadges({ evidence }: { evidence: Evidence }) {
  const badges = qualityBadges(evidence);
  if (badges.length === 0) return null;
  return (
    <Badges aria-label="Data quality" data-testid="hud-drawer-quality" style={{ marginTop: "calc(-1 * var(--gap-s))", marginBottom: "var(--gap-m)" }}>
      {badges.map((b) => (
        <Flag key={b.badge} $tone={b.state ? (FEED_TONE[b.state] ?? "warn") : QUALITY_TONE[b.badge]} data-quality={b.badge}>
          {b.label}
        </Flag>
      ))}
    </Badges>
  );
}

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
          {evidence.feed?.note && (
            <>
              <dt>Feed note</dt>
              <dd data-testid="hud-drawer-feed-note">{evidence.feed.note}</dd>
            </>
          )}
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

const KIND_TITLES: Record<string, string> = {
  sighting: "Sighting",
  reading: "Station reading",
  alert: "Weather alert",
  hotspot: "Hotspot",
  backtest: "How well hotspots did",
  fetch: "Data fetch",
  note: "Field note",
};

const Lead = styled.section`
  margin-bottom: var(--gap-m);

  h3 {
    margin: 0 0 4px;
    font: 600 16px / 1.3 var(--font-ui);
    color: var(--text);
  }

  p {
    margin: 0;
    color: var(--muted);
    font: 400 13px / 1.45 var(--font-ui);
  }

  /* The species line: Latin name in italics, then its status in plain words. */
  p.species {
    margin-bottom: 2px;
    i {
      color: var(--text);
    }
    /* The species icon sits in the line, before the Latin name. */
    svg {
      display: inline-block;
      vertical-align: -3px;
      margin-right: 2px;
    }
  }

  /* The About line reads as body text, and the iNat link sits under it. */
  p.about {
    margin-top: var(--gap-s);
    color: var(--text);
  }

  a.more {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
    color: var(--accent);
    font: 600 12px / 1.4 var(--font-ui);
  }

  img {
    display: block;
    width: 100%;
    max-height: 220px;
    margin-top: var(--gap-s);
    object-fit: cover;
    border-radius: var(--radius-s);
    border: 1px solid var(--border);
  }
`;

const Expert = styled.details`
  border-top: 1px solid var(--border);
  padding-top: var(--gap-s);

  > summary {
    margin-bottom: var(--gap-s);
    color: var(--muted);
    font: 600 12px / 1.6 var(--font-ui);
    cursor: pointer;
  }
`;

/** Everything technical, collapsed: the id, links, source, lag, the normalized record and the raw payload. */
export function ExpertDetails({ id, evidence }: { id: string | null; evidence: Evidence | null }) {
  return (
    <Expert data-testid="drawer-expert">
      <summary>Details for experts</summary>
      <Section>
        <Mono style={{ fontSize: 12, overflowWrap: "anywhere" }} data-testid="hud-drawer-id">
          {id}
        </Mono>
      </Section>
      {evidence && evidence.degraded.length > 0 ? (
        <Note data-testid="schema-degraded">Restart the API to see links: this one is older than the app and has no {evidence.degraded.join(", ")}.</Note>
      ) : null}
      {evidence ? <Record evidence={evidence} /> : null}
    </Expert>
  );
}

/**
 * The plain-language lead: what, where, when, how sure, and the photo when there is one. A sighting adds its
 * species card: the Latin name and status, one About line, and the iNaturalist page in a new tab.
 */
export function Summary({ kind, evidence, atMs }: { kind: string; evidence: Evidence; atMs: number }) {
  const s = plainSummary(kind, evidence.record, atMs);
  if (!s) return null;
  const sp = s.species;
  return (
    <Lead aria-label="Summary" data-testid="evidence-summary">
      <h3>{s.title}</h3>
      {sp ? (
        <p className="species" data-testid="species-status">
          <AppIcon icon={sp.icon} color={sp.color} size={16} />{" "}
          {sp.scientificName ? <i lang="la">{sp.scientificName}</i> : null}
          {sp.scientificName ? " · " : null}
          {sp.status}
        </p>
      ) : null}
      {s.parts.length > 0 ? <p>{s.parts.join(" · ")}</p> : null}
      {/* Same-origin media proxy (/v1/<app>/media/<id>) through the local media cache (client/media). */}
      {s.photo ? <CachedImage src={s.photo} alt={`Photo: ${s.title}`} data-testid="evidence-photo" /> : null}
      {sp?.about ? (
        <p className="about" data-testid="species-about">
          {sp.about}
        </p>
      ) : null}
      {sp?.moreUrl ? (
        <ExternalLink className="more" href={sp.moreUrl} data-testid="species-more">
          {sp.moreLabel} <Icon name="external" />
        </ExternalLink>
      ) : null}
    </Lead>
  );
}

/**
 * Evidence drawer (PRD §3 flow 2): a plain-language lead (T41) and the publisher link up top; under "Details for
 * experts", the id, the normalized record, the raw
 * payload as fetched, source link, fetch time, ingest lag, feed state, and duplicate / revision / conflict
 * links. Hotspot evidence adds the explain panel, and the backtest panel is one click from it.
 */
export default function EvidenceDrawer() {
  const [selection] = useActiveState<HudSelection>(SELECTION);
  const open = isDrawerOpen(selection);
  const id = open ? selection!.evidenceId! : null;
  const [backtestFor, setBacktestFor] = useState<string | null>(null);
  // Ages read against the time cursor, so a replayed record says how old it was then.
  const atMs = Date.parse(useActiveState<TimeState, string>(TIME, (t) => t.at ?? t.to)[0] ?? TIME.defaults.to);
  const kind = id ? id.slice(0, id.indexOf(":")) : "";
  // Field notes (T43) are not Axum evidence: the card reads the local board, so nothing is requested for them.
  const note = kind === "note" ? id!.slice("note:".length) : null;
  const state = useLoad(note ? null : id, () => loadEvidence(id!));
  const hotspot = id ? parseHotspotId(id) : null;
  const backtest = id ? parseBacktestId(id) : null;
  const showBacktest = hotspot !== null && backtestFor === id;

  return (
    <CardScope>
      <Panel
        side="right"
        open={open}
        onClose={closeDrawer}
        width={400}
        title={KIND_TITLES[kind] ?? "Record"}
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
        {state.status === "ready" ? <Summary kind={kind} evidence={state.data} atMs={atMs} /> : null}
        {state.status === "ready" ? <QualityBadges evidence={state.data} /> : null}
        {note && <NoteCard id={note} />}
        {kind === "sighting" && state.status === "ready" && <SightingNoteAction id={id!} evidence={state.data} />}
        {kind === "sighting" && state.status === "ready" && evidenceLocation(state.data.record) && <NearbyAccess at={evidenceLocation(state.data.record)!} />}
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
        <ExpertDetails id={id} evidence={state.status === "ready" ? state.data : null} />
      </Panel>
    </CardScope>
  );
}
