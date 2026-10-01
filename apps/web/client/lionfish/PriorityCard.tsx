"use client";

import { useEffect, useState } from "react";

import ExternalLink from "client/external-link";
import Panel from "client/hud/Panel";
import { Icon } from "client/hud/primitives";
import styled from "client/styled";
import { gqlRequest } from "client/threads/api";
import { copyText, type AppConfig } from "shared/apps";
import { publisherOf } from "shared/source-pages";

import type { CellExplain, ExplainComponent, ExplainEvidence } from "./data";
import { baaWord, COMPONENT_IDS, heatDisagrees, isoDay, utcText, type ComponentId } from "./model";
import type { HelpTopic } from "./store";
import { ComponentBar, Section, Tag } from "./ui";

const Grid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  @container (max-width: 360px) {
    grid-template-columns: 1fr;
  }
`;

const Comp = styled.article`
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-top: 3px solid #f2c14e;
  border-radius: var(--radius-s);
  font: 400 12px / 1.45 var(--font-ui);
  &[data-id="completeness"] {
    border-top-color: var(--muted);
  }
  h4 {
    margin: 0 0 4px;
    font: 600 12.5px / 1.3 var(--font-ui);
  }
  p {
    margin: 4px 0 0;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  /* The rationale is long (the API's full sentence): four lines, the rest on hover or focus. */
  p.why {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  &:hover p.why,
  &:focus-within p.why {
    -webkit-line-clamp: unset;
  }
  details {
    margin-top: 4px;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
  }
  ul {
    margin: 2px 0 0;
    padding-left: 14px;
    font: 400 11px / 1.4 var(--font-mono);
    overflow-wrap: anywhere;
  }
`;

const Field = styled.section`
  margin-bottom: var(--gap-m);
  padding: 8px 10px;
  border: 1px dashed rgba(94, 234, 212, 0.8);
  border-radius: var(--radius-s);
  font: 400 12.5px / 1.45 var(--font-ui);
  h3 {
    margin: 0 0 4px;
    color: rgb(94, 234, 212);
    font: 600 11px / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
`;

const Obs = styled.ol`
  margin: 0;
  padding: 0;
  list-style: none;
  font: 400 12px / 1.45 var(--font-ui);
  li {
    padding: 6px 0;
    border-top: 1px solid var(--border);
  }
  .dates {
    font: 500 11.5px / 1.4 var(--font-mono);
  }
  a {
    color: var(--accent);
    font-weight: 600;
    margin-right: 10px;
    white-space: nowrap;
  }
  a svg {
    display: inline-block;
    width: 11px;
    height: 11px;
    vertical-align: -1px;
  }
`;

const Dl = styled.dl`
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 3px 10px;
  margin: 0;
  font-size: 12.5px;
  dt {
    color: var(--muted);
    font: 600 10.5px / 18px var(--font-mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    line-height: 18px;
  }
`;

const LinkButton = styled.button`
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: 600 12.5px / 1.4 var(--font-ui);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
`;

const COMPONENT_LABEL: Record<ComponentId, string> = { recentReports: "Recent reports", idQuality: "Identification quality", heatStress: "Reef heat stress", completeness: "Data completeness" };
const MAX_OBS = 12;

/** Publisher pages of the listed sightings (`Evidence.sourcePageUrl`), one batched request. */
function useSourcePages(ids: readonly string[]): Record<string, string> {
  const [pages, setPages] = useState<Record<string, string>>({});
  const key = ids.join(",");
  useEffect(() => {
    const list = key ? key.split(",").filter((id) => /^sighting:\d+$/.test(id)) : [];
    if (!list.length) return;
    const ctl = new AbortController();
    gqlRequest<Record<string, { sourcePageUrl: string | null } | null>>(`query LionfishPages { ${list.map((id, i) => `p${i}: evidence(id: "${id}") { sourcePageUrl }`).join(" ")} }`, {}, ctl.signal).then(
      (res) => {
        if (ctl.signal.aborted) return;
        const out: Record<string, string> = {};
        list.forEach((id, i) => {
          const url = res[`p${i}`]?.sourcePageUrl;
          if (url && publisherOf(url)) out[id] = url;
        });
        setPages(out);
      },
      () => {},
    );
    return () => ctl.abort();
  }, [key]);
  return pages;
}

function ComponentBox({ id, c }: { id: ComponentId; c: ExplainComponent }) {
  return (
    <Comp data-id={id} data-component={id} data-state={c.state.toLowerCase()} aria-label={COMPONENT_LABEL[id]}>
      <h4>{COMPONENT_LABEL[id]}</h4>
      <ComponentBar c={c} label={COMPONENT_LABEL[id]} /> <Tag $tone={c.state === "OK" ? "ok" : "warn"}>{c.state.toLowerCase()}</Tag>
      <p>{id === "completeness" ? "Weight 0: lowers confidence, never the rank." : `Weight ${c.weight} in the rank.`}</p>
      <p className="why">{c.rationale}</p>
      <details>
        <summary>Inputs ({c.inputs.length})</summary>
        <ul>{c.inputs.length ? c.inputs.map((x) => <li key={x}>{x}</li>) : <li>none</li>}</ul>
      </details>
    </Comp>
  );
}

export type PriorityCardProps = {
  app: AppConfig;
  rank: number | null;
  areaName: string;
  cell: string;
  atMs: number;
  live: boolean;
  explain: CellExplain | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onHelp: (t: HelpTopic | "all") => void;
};

/** Evidence card of one ranked cell: four components side by side, CRW heat, the field window apart, the records. */
export function PriorityCardView(p: PriorityCardProps) {
  const ex = p.explain;
  const observations: ExplainEvidence[] = ex?.components ? [...ex.components.recentReports.evidence].filter((e) => e.kind === "sighting").sort((a, b) => Date.parse(b.observedAt ?? "") - Date.parse(a.observedAt ?? "")) : [];
  const shown = observations.slice(0, MAX_OBS);
  const pages = useSourcePages(shown.map((o) => o.id));
  const heat = ex?.heat ?? null;
  const fw = ex?.fieldWindow ?? null;
  return (
    <div data-testid="lionfish-card" data-cell={p.cell} data-asof={p.live ? "live" : p.atMs} style={{ containerType: "inline-size" }}>
      <Section>
        <p>
          <b>
            {p.rank !== null ? `Priority ${p.rank}` : "Cell"} · {p.areaName}
          </b>{" "}
          {ex?.thin ? <Tag $tone="warn">thin area: low confidence</Tag> : null}
        </p>
        <p className="muted">
          Cell {p.cell} · {p.live ? `live, as of ${utcText(p.atMs)}` : `known at ${utcText(p.atMs)} (reports submitted by then)`}
        </p>
        <p className="muted">{copyText(p.app, "priorityNote", "Ranks where to look first; not a risk or probability.")}</p>
        {ex?.rankScore !== null && ex?.rankScore !== undefined ? <p className="muted">Rank score {ex.rankScore.toFixed(2)}: a weighted mean that only orders cells.</p> : null}
      </Section>

      {p.loading ? <p>Loading the evidence…</p> : null}
      {p.error ? <p role="alert">Could not load this cell: {p.error}</p> : null}

      {ex?.components ? (
        <Section aria-label="Components">
          <h3>Four components, shown separately</h3>
          <Grid data-testid="lionfish-components">
            {COMPONENT_IDS.map((id) => (
              <ComponentBox key={id} id={id} c={ex.components![id]} />
            ))}
          </Grid>
        </Section>
      ) : null}

      {ex ? (
        <Section aria-label="Reef heat stress" data-testid="lionfish-card-heat">
          <h3>Reef heat stress at the cell (NOAA CRW)</h3>
          {heat ? (
            <>
              <Dl>
                <dt>DHW</dt>
                <dd data-testid="lionfish-card-dhw">{heat.dhw === null ? "unknown" : `${heat.dhw.toFixed(2)} °C-weeks (accumulated, 12 weeks)`}</dd>
                <dt>BAA</dt>
                <dd data-testid="lionfish-card-baa">{heat.baa === null ? "unknown" : `${baaWord(heat.baa)} (level ${heat.baa}, today)`}</dd>
                <dt>SST</dt>
                <dd>{heat.sst === null ? "unknown" : `${heat.sst.toFixed(2)} °C`}</dd>
                <dt>Anomaly</dt>
                <dd>{heat.anomaly === null ? "unknown" : `${heat.anomaly >= 0 ? "+" : ""}${heat.anomaly.toFixed(2)} °C`}</dd>
                <dt>Product</dt>
                <dd>
                  day {isoDay(Date.parse(heat.observedAt))} (observed) · received {utcText(Date.parse(heat.ingestedAt))}
                </dd>
                <dt>Credit</dt>
                <dd data-testid="lionfish-card-credit">{heat.credit}</dd>
              </Dl>
              {heatDisagrees(heat) ? <p>DHW and BAA disagree here: accumulated stress is high while today&apos;s alert is low, or the other way round. Both are shown.</p> : null}
            </>
          ) : (
            <>
              <Dl data-state="unknown">
                <dt>DHW</dt>
                <dd data-testid="lionfish-card-dhw">unknown</dd>
                <dt>BAA</dt>
                <dd data-testid="lionfish-card-baa">unknown</dd>
              </Dl>
              <p>No CRW product within reach of this cell at this time: unknown, not zero.</p>
            </>
          )}
          <p className="muted">{copyText(p.app, "heatNote", "Heat stress is context, not proof of damage.")}</p>
          <p>
            <LinkButton type="button" onClick={() => p.onHelp("dhw")} data-testid="lionfish-card-help">
              What DHW and BAA mean, and why they can disagree
            </LinkButton>
          </p>
        </Section>
      ) : null}

      {ex ? (
        <Field data-testid="lionfish-card-field" aria-label="Field window">
          <h3>Field window · not part of priority</h3>
          {fw && fw.state === "OK" ? (
            <>
              Waves {fw.waveMinM?.toFixed(1) ?? "?"} to {fw.waveMaxM?.toFixed(1) ?? "?"} m; {fw.calmHours ?? "?"} of {fw.horizonHours} forecast hours under 1.2 m. Current up to {fw.currentMaxMs === null ? "unknown" : `${fw.currentMaxMs.toFixed(2)} m/s`}.
              <br />
              <small>Open-Meteo Marine forecast issued {fw.issuedAt ? utcText(Date.parse(fw.issuedAt)) : "?"} (modelled).</small>
            </>
          ) : (
            <>
              No usable wave forecast at the nearest marine point{fw?.currentMaxMs !== null && fw?.currentMaxMs !== undefined ? `; current up to ${fw.currentMaxMs.toFixed(2)} m/s` : ""}. Unknown, not calm.
            </>
          )}
        </Field>
      ) : null}

      {ex?.components ? (
        <Section aria-label="Observations" data-testid="lionfish-card-observations">
          <h3>Reports behind recent reports ({observations.length})</h3>
          <Obs>
            {shown.map((o) => (
              <li key={o.id} data-evidence={o.id}>
                <div className="dates">
                  observed {o.observedAt ? isoDay(Date.parse(o.observedAt)) : "unknown"} · submitted {o.submittedAt ? isoDay(Date.parse(o.submittedAt)) : "unknown"}
                  {o.weight === null ? " · not counted" : ` · weight ${o.weight.toFixed(3)}`}
                </div>
                <div>{o.detail}</div>
                {o.url ? (
                  <ExternalLink href={o.url} data-photo="">
                    Photo&nbsp;<Icon name="external" />
                  </ExternalLink>
                ) : null}
                {pages[o.id] ? (
                  <ExternalLink href={pages[o.id]!} data-page="">
                    {publisherOf(pages[o.id]!)} record&nbsp;<Icon name="external" />
                  </ExternalLink>
                ) : null}
              </li>
            ))}
          </Obs>
          {observations.length > shown.length ? <p className="muted">and {observations.length - shown.length} older reports with smaller weights.</p> : null}
          {observations.length === 0 ? <p className="muted">No reports within reach of this cell. No reports means no reports, not no lionfish.</p> : null}
        </Section>
      ) : null}

      {ex ? (
        <Section aria-label="Caveats" data-testid="lionfish-card-caveats">
          <h3>Caveats</h3>
          <ul style={{ margin: 0, paddingLeft: 16, font: "400 12.5px / 1.45 var(--font-ui)" }}>
            {ex.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          {ex.credit ? <p className="muted">{ex.credit}</p> : null}
        </Section>
      ) : null}
    </div>
  );
}

export default function PriorityCard(p: PriorityCardProps & { open: boolean }) {
  return (
    <Panel side="right" title={`Survey priority · ${p.areaName}`} open={p.open} onClose={p.onClose} width={430} data-testid="lionfish-card-panel">
      {p.open ? <PriorityCardView {...p} /> : null}
    </Panel>
  );
}
