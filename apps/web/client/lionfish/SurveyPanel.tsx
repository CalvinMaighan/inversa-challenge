"use client";

import ExternalLink from "client/external-link";
import Panel from "client/hud/Panel";
import { Icon, Pill } from "client/hud/primitives";
import styled from "client/styled";
import { copyText, LAYER_IDS, type AppConfig } from "shared/apps";

import { baaWord, componentText, feedChip, isoDay, utcText, WINDOW_DAYS, type AreaHeat, type Basis, type FeedRow, type LagStats, type PriorityCell, type ReportCount, type SstPair, type WindowDays } from "./model";
import type { HelpTopic } from "./store";
import { Chip, ChipRow, ComponentBar, Section, Tag } from "./ui";

const [SIGHTINGS, HOTSPOTS] = LAYER_IDS;
/** Desktop: the panel scrolls within this height, so the map below it stays in view. */
const SURVEY_MAX_HEIGHT = 560;

const AreaGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  button {
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
    min-height: 52px;
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
`;

const Toggle = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
  font: 500 12.5px / 1.35 var(--font-ui);
  cursor: pointer;
  input {
    margin: 2px 0 0;
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
    flex: none;
  }
  small {
    display: block;
    color: var(--muted);
    font-weight: 400;
  }
`;

const Segmented = styled.div`
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  overflow: hidden;
  button {
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    color: var(--text);
    font: 600 12px / 1 var(--font-ui);
    cursor: pointer;
  }
  button + button {
    border-left: 1px solid var(--border);
  }
  button[aria-pressed="true"] {
    background: color-mix(in oklch, var(--accent) 22%, transparent);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
`;

const Count = styled.p`
  && {
    font: 600 13px / 1.4 var(--font-ui);
  }
`;

const CellList = styled.ol`
  margin: 0;
  padding: 0;
  list-style: none;
  li + li {
    margin-top: 4px;
  }
  button {
    width: 100%;
    display: grid;
    grid-template-columns: 22px 1fr;
    gap: 2px 8px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--text);
    text-align: left;
    font: 400 12px / 1.35 var(--font-ui);
    cursor: pointer;
  }
  button[aria-pressed="true"] {
    border-color: var(--accent);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .rank {
    grid-row: span 3;
    font: 700 14px / 1.4 var(--font-mono);
    color: #f2c14e;
  }
  .comps {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 1px 8px;
    color: var(--muted);
  }
  .comps b {
    color: var(--text);
  }
`;

const Sparse = styled.div`
  padding: 8px 10px;
  border: 1px dashed var(--warn);
  border-radius: var(--radius-s);
  background: repeating-linear-gradient(135deg, color-mix(in oklch, var(--warn) 8%, transparent) 0 6px, transparent 6px 12px);
  font: 400 12.5px / 1.45 var(--font-ui);
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

/** Area name over its values: the panel is too narrow for a name column. */
const Stacked = styled(Dl)`
  grid-template-columns: 1fr;
  gap: 0;
  dd {
    margin-bottom: 8px;
  }
`;

const Conflict = styled.div<{ $disagree: boolean }>`
  padding: 6px 8px;
  border: 1px solid ${(p) => (p.$disagree ? "color-mix(in oklch, var(--danger) 60%, transparent)" : "var(--border)")};
  border-radius: var(--radius-s);
  background: ${(p) => (p.$disagree ? "color-mix(in oklch, var(--danger) 10%, transparent)" : "transparent")};
  font: 400 12px / 1.45 var(--font-ui);
  b {
    display: block;
  }
`;

const LinkButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: 600 12.5px / 1.4 var(--font-ui);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
`;

export type AreaRow = { id: string; name: string; thin: boolean; count: ReportCount; newestObservedMs: number | null; heat: AreaHeat };

export type SurveyPanelProps = {
  app: AppConfig;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  areas: AreaRow[];
  area: string | null;
  onArea: (id: string | null) => void;
  layers: { reports: boolean; heat: boolean; priority: boolean; field: boolean };
  onLayer: (id: "reports" | "heat" | "priority" | "field", on: boolean) => void;
  basis: Basis;
  onBasis: (b: Basis) => void;
  days: WindowDays;
  onDays: (d: WindowDays) => void;
  lateOnly: boolean;
  onLateOnly: (on: boolean) => void;
  total: ReportCount;
  lag: LagStats | null;
  submittedSource: "field" | "evidence" | "none" | null;
  cells: { cell: PriorityCell; rank: number }[];
  priorityAtMs: number | null;
  replayReady: boolean;
  selectedCell: string | null;
  onCell: (c: PriorityCell) => void;
  feeds: FeedRow[] | null;
  sstPair: SstPair | null;
  onHelp: (topic: HelpTopic | "all") => void;
  loading: boolean;
  errors: string[];
};

const layerLabel = (app: AppConfig, id: string, fallback: string) => app.layers.find((l) => l.id === id)?.label ?? fallback;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The left panel: four area chips, layer toggles, the date basis and window with the late-upload filter, the
 * ranked survey cells, reef heat per area, and data quality (feed modes and states, buoy against satellite).
 */
export default function SurveyPanel(p: SurveyPanelProps) {
  const { app } = p;
  const selected = p.areas.find((a) => a.id === p.area) ?? null;
  const basisWord = p.basis === "observed" ? "observed" : "submitted";
  return (
    <Panel side="left" title="Lionfish survey" tabLabel="Survey" open={p.open} onOpen={p.onOpen} onClose={p.onClose} width={340} maxHeight={SURVEY_MAX_HEIGHT} data-testid="lionfish-panel">
      <Section aria-label="Areas">
        <h3>Areas</h3>
        <AreaGrid role="group" aria-label="Fly to an area">
          {p.areas.map((a) => (
            <Chip
              key={a.id}
              type="button"
              data-area={a.id}
              data-thin={a.thin ? "" : undefined}
              aria-pressed={p.area === a.id}
              aria-label={`${a.name}: ${plural(a.count.independent, "report")} ${basisWord} in ${p.days} days${a.thin ? ", thin data" : ""}`}
              onClick={() => p.onArea(p.area === a.id ? null : a.id)}
            >
              <span>{a.name}</span>
              <span className="row">
                <small data-count={a.count.independent}>{p.loading ? "…" : plural(a.count.independent, "report")}</small>
                {a.thin ? <Tag $tone="warn">Thin data</Tag> : null}
              </span>
            </Chip>
          ))}
        </AreaGrid>
        {selected?.thin ? (
          <Sparse data-testid="lionfish-sparse" role="note" style={{ marginTop: 8 }}>
            <b>{selected.name}: sparse data.</b> {copyText(app, "thinAreaNote", "Too few recent records for a ranked score.")} {plural(selected.count.independent, "independent report")} {basisWord} in the last {p.days} days
            {selected.newestObservedMs ? `; newest observed ${isoDay(selected.newestObservedMs)}` : "; none loaded"}. No reports means no reports, not no lionfish.
          </Sparse>
        ) : null}
      </Section>

      <Section aria-label="Layers">
        <h3>Layers</h3>
        <Toggle>
          <input type="checkbox" data-layer="reports" checked={p.layers.reports} onChange={(e) => p.onLayer("reports", e.currentTarget.checked)} />
          <span>
            {layerLabel(app, SIGHTINGS, "Lionfish reports")}
            <small>One dot per report; white corner: uploaded more than 30 days after the dive; dashed ring: a GBIF copy of an iNaturalist record, never counted.</small>
          </span>
        </Toggle>
        <Toggle>
          <input type="checkbox" data-layer="heat" checked={p.layers.heat} onChange={(e) => p.onLayer("heat", e.currentTarget.checked)} />
          <span>
            {layerLabel(app, "heat", "Reef heat stress (CRW)")}
            <small>Fill: DHW (accumulated). Outline: BAA (today&apos;s alert). Hatched: stale or missing, never zero.</small>
          </span>
        </Toggle>
        <Toggle>
          <input type="checkbox" data-layer="priority" checked={p.layers.priority} onChange={(e) => p.onLayer("priority", e.currentTarget.checked)} />
          <span>
            {layerLabel(app, HOTSPOTS, "Survey priority")}
            <small>Numbered squares: ranked cells. Dashed: thin area, low confidence.</small>
          </span>
        </Toggle>
        <Toggle>
          <input type="checkbox" data-layer="field" checked={p.layers.field} onChange={(e) => p.onLayer("field", e.currentTarget.checked)} />
          <span>
            Field window (waves, currents)
            <small>Teal rings fill with calm forecast hours. Planning only; not part of priority.</small>
          </span>
        </Toggle>
      </Section>

      <Section aria-label="Reports" data-testid="lionfish-reports">
        <h3>Reports</h3>
        <ChipRow style={{ alignItems: "center" }}>
          <Segmented role="group" aria-label="Count reports by">
            <button type="button" data-basis="observed" aria-pressed={p.basis === "observed"} onClick={() => p.onBasis("observed")}>
              Observed date
            </button>
            <button type="button" data-basis="submitted" aria-pressed={p.basis === "submitted"} onClick={() => p.onBasis("submitted")}>
              Submitted date
            </button>
          </Segmented>
          <Segmented role="group" aria-label="Window">
            {WINDOW_DAYS.map((d) => (
              <button key={d} type="button" data-days={d} aria-pressed={p.days === d} onClick={() => p.onDays(d)}>
                {d} d
              </button>
            ))}
          </Segmented>
        </ChipRow>
        <Count data-testid="lionfish-count" data-basis={p.basis} data-count={p.total.independent}>
          {p.loading ? "Loading reports…" : `${plural(p.total.independent, "independent report")} ${basisWord} in the last ${p.days} days`}
          {p.total.copies ? <small> (+{p.total.copies} GBIF {p.total.copies === 1 ? "copy" : "copies"} of iNaturalist, not counted)</small> : null}
        </Count>
        {p.basis === "submitted" && p.total.noSubmittedDate ? <p className="muted">{plural(p.total.noSubmittedDate, "GBIF or NAS record")} in the observed window carry no submitted date and are left out here.</p> : null}
        <Toggle>
          <input type="checkbox" data-testid="lionfish-late" checked={p.lateOnly} onChange={(e) => p.onLateOnly(e.currentTarget.checked)} />
          <span>
            Newly submitted reports of older sightings
            <small>Only reports uploaded more than 30 days after the dive.</small>
          </span>
        </Toggle>
        <p className="muted" data-testid="lionfish-lag">
          {copyText(app, "lagNote", "Observed and submitted dates can differ by years.")}
          {p.lag && p.lag.n ? ` Among the iNaturalist reports observed in the last 90 days: median lag ${p.lag.medianDays!.toFixed(1)} days; ${p.lag.lateCount} of ${p.lag.n} uploaded more than 30 days late (old photos uploaded recently are not in this sample).` : ""}
          {p.submittedSource === "evidence" ? " Submitted dates read from each record's evidence." : p.submittedSource === "none" ? " Submitted dates are not available from the API yet." : ""}
        </p>
      </Section>

      <Section aria-label="Survey priority" data-testid="lionfish-priority">
        <h3>Survey priority</h3>
        <p className="muted">{copyText(app, "priorityNote", "Ranks where to look first; not a risk or probability.")}</p>
        {p.priorityAtMs !== null ? <p className="muted">Computed for {utcText(p.priorityAtMs)} from reports submitted by then.</p> : null}
        {p.cells.length === 0 ? (
          <p className="muted">{p.loading ? "Loading…" : "No ranked cells for this time."}</p>
        ) : (
          <CellList>
            {p.cells.map(({ cell: c, rank }) => (
              <li key={c.cell}>
                <button type="button" data-cell-row={c.cell} aria-pressed={p.selectedCell === c.cell} onClick={() => p.onCell(c)}>
                  <span className="rank">{rank}</span>
                  <span>
                    {p.areas.find((a) => a.id === c.regionId)?.name ?? c.regionId} {c.thin ? <Tag $tone="warn">thin: low confidence</Tag> : null}
                  </span>
                  <span className="comps">
                    <span>Reports</span>
                    <ComponentBar c={c.components.recentReports} label="Recent reports" />
                    <span>ID quality</span>
                    <ComponentBar c={c.components.idQuality} label="Identification quality" />
                    <span>Heat</span>
                    <ComponentBar c={c.components.heatStress} label="Reef heat stress" />
                    <span>Complete</span>
                    <span>
                      <b>{componentText(c.components.completeness)}</b> <small>(confidence, not rank)</small>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </CellList>
        )}
        {!p.replayReady ? <p className="muted">Loading daily priority for the timeline…</p> : null}
      </Section>

      <Section aria-label="Reef heat stress" data-testid="lionfish-heat">
        <h3>Reef heat stress (NOAA CRW)</h3>
        <p className="muted">{copyText(app, "heatNote", "Heat stress is context, not proof of damage.")}</p>
        <Stacked>
          {p.areas.map((a) => {
            const h = a.heat;
            const state = h.pixels === 0 ? "no pixels" : h.ok > 0 ? "ok" : h.stale > 0 ? "stale" : "missing";
            return (
              <div key={a.id} style={{ display: "contents" }}>
                <dt>{a.name}</dt>
                <dd data-heat-area={a.id} data-state={state}>
                  {h.ok + h.stale > 0 ? (
                    <>
                      DHW {h.maxDhw === null ? "unknown" : h.maxDhw.toFixed(1)} °C-weeks · BAA {baaWord(h.maxBaa)}
                      {h.disagree ? (
                        <>
                          {" "}
                          <Tag $tone="warn" data-testid="lionfish-disagree">
                            DHW and BAA disagree in places
                          </Tag>
                        </>
                      ) : null}
                      <br />
                      <small>
                        product day {h.dayMs ? isoDay(h.dayMs) : "?"} (observed){state === "stale" ? " · stale: older than 72 h" : ""}
                      </small>
                    </>
                  ) : (
                    <Tag $tone="muted">{state === "no pixels" ? "no CRW pixels loaded" : "missing: no CRW product held for this day"}</Tag>
                  )}
                </dd>
              </div>
            );
          })}
        </Stacked>
        <p>
          <LinkButton type="button" onClick={() => p.onHelp("baa")} data-testid="lionfish-help-baa">
            Why DHW and BAA can disagree
          </LinkButton>
        </p>
      </Section>

      <Section aria-label="Data quality" data-testid="lionfish-quality">
        <h3>Data quality</h3>
        {p.sstPair ? (
          <Conflict $disagree={p.sstPair.disagree} data-testid="lionfish-sst-conflict" data-disagree={p.sstPair.disagree ? "1" : "0"} role="note">
            <b>{p.sstPair.disagree ? "Buoy and satellite disagree (Florida)" : "Buoy and satellite agree within 0.5 °C (Florida)"}</b>
            Buoy {p.sstPair.buoy.name}: {p.sstPair.buoy.valueC.toFixed(1)} °C measured {utcText(p.sstPair.buoy.observedMs)} (NOAA NDBC). Satellite: {p.sstPair.satellite.valueC.toFixed(1)} °C, CRW product day {isoDay(p.sstPair.satellite.dayMs)}, {p.sstPair.distanceKm.toFixed(0)} km away. Difference {p.sstPair.diffC >= 0 ? "+" : ""}
            {p.sstPair.diffC.toFixed(1)} °C; not blended. Buoys measure about a metre down at one moment, the satellite a 5 km daily value.
          </Conflict>
        ) : (
          <p className="muted" data-testid="lionfish-sst-conflict" data-disagree="none">
            No buoy and satellite SST pair at this time. Only Florida has sea-temperature buoys in these areas.
          </p>
        )}
        <h3 style={{ marginTop: 10 }}>Feeds</h3>
        {p.feeds ? (
          <ChipRow data-testid="lionfish-feeds">
            {p.feeds.map((f) => {
              const c = feedChip(f);
              return (
                <Pill key={f.source} $tone={c.tone} data-feed={f.source} data-mode={c.mode} data-state={c.state} title={f.note ?? undefined}>
                  <Icon name={c.mode === "push" ? "push" : "poll"} /> {f.source} · {c.mode} · {c.state}
                </Pill>
              );
            })}
          </ChipRow>
        ) : (
          <p className="muted">Loading feed states…</p>
        )}
      </Section>

      <Section aria-label="Help">
        <LinkButton type="button" onClick={() => p.onHelp("all")} data-testid="lionfish-help-open">
          <Icon name="help" /> Ocean data guide: SST, anomaly, DHW, BAA, waves, currents
        </LinkButton>
        <p className="muted">
          Data: <ExternalLink href="https://coralreefwatch.noaa.gov">NOAA Coral Reef Watch</ExternalLink>, <ExternalLink href="https://www.inaturalist.org">iNaturalist</ExternalLink>, <ExternalLink href="https://www.gbif.org">GBIF</ExternalLink>, <ExternalLink href="https://nas.er.usgs.gov">USGS NAS</ExternalLink>, <ExternalLink href="https://open-meteo.com">Open-Meteo</ExternalLink>.
        </p>
        {p.errors.length ? (
          <p className="muted" role="status">
            Not loaded: {p.errors.join("; ")}
          </p>
        ) : null}
      </Section>
    </Panel>
  );
}
