"use client";

import ExternalLink from "client/external-link";
import Panel from "client/hud/Panel";
import { Icon, SectionTitle } from "client/hud/primitives";
import styled from "client/styled";

import type { Briefing } from "./briefing";
import { conflictText, flowAvailability } from "./briefing";
import { ago, cfs, ft, kcfs, localTime, utcTime } from "./format";
import { forecastPeak, latestAt, thresholdList, type Alert, type SeriesPoint, type Site, type SiteStatus, type Snapshot, type SourceConflict, type Thresholds, type UsgsSeries } from "./model";
import { forecastSourceLabel, sourceLinks, STATUS_WORDS, type SiteReview } from "./review";
import { StatusGlyph, STATUS_TONE } from "./StatusGlyph";

const Card = styled.section<{ $tone: string }>`
  margin-bottom: var(--gap-m);
  padding: var(--gap-s) var(--gap-m) var(--gap-m);
  border: 1px solid var(--border);
  border-top: 3px solid ${(p) => p.$tone};
  border-radius: var(--radius-s);
  h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 6px;
    font: 600 15px / 1.3 var(--font-ui);
  }
  h4 {
    margin: var(--gap-s) 0 2px;
    color: var(--muted);
    font: 600 10.5px / 1.4 var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  ul {
    margin: 0;
    padding-left: 16px;
    font: 400 12.5px / 1.45 var(--font-ui);
  }
  li + li {
    margin-top: 2px;
  }
  p.asof {
    margin: 0 0 4px;
    color: var(--muted);
    font: 400 12px / 1.4 var(--font-ui);
  }
`;

const Section = styled.section`
  margin-bottom: var(--gap-m);
`;

const Meta = styled.dl`
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 3px var(--gap-m);
  margin: 0;
  font-size: 12.5px;
  dt {
    color: var(--muted);
    font: 600 10px / 18px var(--font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
    line-height: 18px;
  }
  small {
    color: var(--muted);
  }
`;

const Disagree = styled.div`
  margin: 0 0 var(--gap-s);
  padding: 6px 8px;
  border: 1px solid color-mix(in oklch, var(--danger) 60%, transparent);
  border-radius: var(--radius-s);
  background: color-mix(in oklch, var(--danger) 10%, transparent);
  font: 400 12px / 1.4 var(--font-ui);
  b {
    display: block;
    font-weight: 600;
  }
`;

const Links = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  li + li {
    margin-top: 4px;
  }
  a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent);
    font: 600 12.5px / 1.4 var(--font-ui);
  }
`;

const Muted = styled.p`
  margin: 0;
  color: var(--muted);
  font: 400 12.5px / 1.45 var(--font-ui);
`;

export type SiteEvidence = {
  site: Site;
  asOfMs: number;
  live: boolean;
  zone: string;
  review: SiteReview | null;
  briefing: Briefing | null;
  status: SiteStatus | null;
  thresholds: Thresholds | null;
  forecast: Snapshot | null;
  /** USGS readings known at the as-of time, and over the whole chart window. */
  usgs: UsgsSeries;
  usgsWindow: UsgsSeries;
  alerts: readonly Alert[] | null;
  conflicts: readonly SourceConflict[];
  weather: { airC: SeriesPoint | null; windMs: SeriesPoint | null } | null;
  loading: boolean;
  error: string | null;
};

const when = (ms: number | null | undefined, zone: string) => (ms === null || ms === undefined || !Number.isFinite(ms) ? "—" : `${localTime(ms, zone)} (${utcTime(ms)})`);

/** Briefing card plus the evidence behind it. Pure view: everything comes in as props. */
export function SiteDrawerView(p: SiteEvidence) {
  const { site, asOfMs, live, zone, review, briefing, status, thresholds, forecast, usgs, alerts, conflicts, weather } = p;
  const links = sourceLinks(site);
  const tone = review ? STATUS_TONE[review.status] : "var(--border)";
  const obs = status?.observation ?? null;
  const usgsStage = latestAt(usgs.stageFt, asOfMs);
  const usgsFlow = latestAt(usgs.dischargeCfs, asOfMs);
  const peak = forecastPeak(forecast);
  const th = thresholdList(thresholds);
  const flow = flowAvailability(p.usgsWindow, usgs);
  return (
    <div data-testid="carp-drawer" data-site={site.lid} data-asof={live ? "live" : asOfMs}>
      <Card $tone={tone} data-testid="carp-briefing" aria-label="Location briefing">
        <h3>
          {review ? <StatusGlyph status={review.status} /> : null}
          {review ? STATUS_WORDS[review.status] : p.loading ? "Loading…" : "No status"}
        </h3>
        <p className="asof">{live ? `Live, as of ${localTime(asOfMs, zone)}.` : `What we knew at ${localTime(asOfMs, zone)}.`}</p>
        {review && review.reasons.some((r) => r.kind === "review") ? (
          <ul data-testid="carp-briefing-reasons">
            {review.reasons
              .filter((r) => r.kind === "review")
              .map((r, i) => (
                <li key={i} data-rule={r.rule}>
                  {r.text}
                </li>
              ))}
          </ul>
        ) : null}
        {briefing ? (
          <>
            <h4>What changed</h4>
            <ul data-testid="carp-changed">{briefing.changed.length ? briefing.changed.map((t, i) => <li key={i}>{t}</li>) : <li>Nothing new was held for this period.</li>}</ul>
            <h4>What is expected</h4>
            <ul data-testid="carp-expected">{briefing.expected.length ? briefing.expected.map((t, i) => <li key={i}>{t}</li>) : <li>No forecast was held for this period.</li>}</ul>
            <h4>What is missing</h4>
            <ul data-testid="carp-missing">{briefing.missing.length ? briefing.missing.map((t, i) => <li key={i}>{t}</li>) : <li>Nothing: every feed answered for this location.</li>}</ul>
          </>
        ) : (
          <Muted>{p.error ? `Could not load this location: ${p.error}` : "Loading the briefing…"}</Muted>
        )}
      </Card>

      {conflicts.map((c) => {
        const t = conflictText(c, zone);
        return (
          <Disagree key={c.kind} data-testid="carp-conflict" data-kind={c.kind} role="note">
            <b>{t.title}</b>
            {t.detail}
          </Disagree>
        );
      })}

      <Section aria-label="Readings" data-testid="carp-evidence-readings">
        <SectionTitle>Readings</SectionTitle>
        <Meta>
          <dt>NWPS stage</dt>
          <dd data-testid="carp-nwps-stage">
            {obs?.stageFt !== null && obs?.stageFt !== undefined ? (
              <>
                {ft(obs.stageFt)} <small>NWPS datum, used for flood categories</small>
                <br />
                <small>
                  observed {when(Date.parse(obs.observedAt), zone)}, {ago(Date.parse(obs.observedAt), asOfMs)}; received {when(Date.parse(obs.ingestedAt), zone)}
                </small>
              </>
            ) : (
              <>No NWPS stage observation was held at this time.</>
            )}
          </dd>
          <dt>USGS gauge height</dt>
          <dd data-testid="carp-usgs-stage">
            {usgsStage ? (
              <>
                {ft(usgsStage.v)} <small>USGS {site.usgs} datum; for change over time, not categories</small>
                <br />
                <small>
                  observed {when(usgsStage.t, zone)}, {ago(usgsStage.t, asOfMs)}
                </small>
              </>
            ) : (
              <>No USGS gauge height was held for this period.</>
            )}
          </dd>
          <dt>Flow</dt>
          <dd data-testid="carp-flow">
            {flow === "not_measured" ? (
              <>Not measured at this gauge (USGS {site.usgs}).</>
            ) : flow === "no_readings" ? (
              <>No USGS readings in this window.</>
            ) : usgsFlow ? (
              <>
                {cfs(usgsFlow.v)} <small>USGS discharge, {when(usgsFlow.t, zone)}</small>
              </>
            ) : (
              <>No USGS discharge held at this time.</>
            )}
            {typeof obs?.flowKcfs === "number" ? (
              <>
                <br />
                {kcfs(obs.flowKcfs)} <small>NWS estimate (NWPS), not blended with USGS</small>
              </>
            ) : null}
          </dd>
          {live && weather && (weather.airC || weather.windMs) ? (
            <>
              <dt>Weather</dt>
              <dd>
                {weather.airC ? `${weather.airC.v.toFixed(1)} °C air` : ""}
                {weather.airC && weather.windMs ? ", " : ""}
                {weather.windMs ? `wind ${weather.windMs.v.toFixed(1)} m/s` : ""} <small>NWS gridpoint forecast for {when((weather.airC ?? weather.windMs)!.t, zone)}, modelled</small>
              </dd>
            </>
          ) : null}
        </Meta>
      </Section>

      <Section aria-label="Forecast" data-testid="carp-evidence-forecast">
        <SectionTitle>River forecast</SectionTitle>
        {forecast ? (
          <Meta>
            <dt>Issued</dt>
            <dd data-testid="carp-forecast-issued">
              {when(Date.parse(forecast.issuedAt), zone)} <small>{ago(Date.parse(forecast.issuedAt), asOfMs)}</small>
            </dd>
            <dt>Source</dt>
            <dd data-testid="carp-forecast-source" data-source={forecast.source}>
              {forecastSourceLabel(forecast.source)}
              {forecast.revision > 0 ? ` · revision ${forecast.revision}` : ""}
            </dd>
            <dt>Valid</dt>
            <dd>
              {when(Date.parse(forecast.validFrom ?? forecast.points[0]?.validAt ?? ""), zone)} to {when(Date.parse(forecast.horizonEnd ?? forecast.validTo ?? ""), zone)}
            </dd>
            <dt>Peak</dt>
            <dd>{peak ? `${ft(peak.ft, 1)} at ${localTime(peak.at, zone)}` : "—"}</dd>
            <dt>Received</dt>
            <dd>{when(Date.parse(forecast.ingestedAt), zone)}</dd>
          </Meta>
        ) : (
          <Muted>No river forecast was held at this time.</Muted>
        )}
      </Section>

      <Section aria-label="Flood thresholds" data-testid="carp-evidence-thresholds">
        <SectionTitle>Flood thresholds (NWPS stage)</SectionTitle>
        {th.length ? (
          <Meta>
            {th.map((t) => (
              <div key={t.key} style={{ display: "contents" }}>
                <dt>{t.label}</dt>
                <dd>{ft(t.ft, 1)}</dd>
              </div>
            ))}
          </Meta>
        ) : (
          <Muted>No flood thresholds are defined or known for this gauge.</Muted>
        )}
      </Section>

      <Section aria-label="NWS alerts" data-testid="carp-evidence-alerts">
        <SectionTitle>NWS alerts</SectionTitle>
        {alerts === null ? (
          <Muted>Alerts not loaded yet.</Muted>
        ) : alerts.length === 0 ? (
          <Muted>No active NWS alerts at the location, checked for {localTime(asOfMs, zone)}.</Muted>
        ) : (
          <Meta>
            {alerts.map((a) => (
              <div key={a.id} style={{ display: "contents" }}>
                <dt>{a.severity}</dt>
                <dd>
                  {a.event}
                  {a.expires ? ` until ${localTime(Date.parse(a.expires), zone)}` : ""}
                </dd>
              </div>
            ))}
          </Meta>
        )}
      </Section>

      <Section aria-label="Sources" data-testid="carp-evidence-links">
        <SectionTitle>Sources</SectionTitle>
        <Links>
          <li>
            <ExternalLink href={links.nwps}>
              NWPS gauge {site.lid} <Icon name="external" />
            </ExternalLink>
          </li>
          {links.usgs ? (
            <li>
              <ExternalLink href={links.usgs}>
                USGS {site.usgs} <Icon name="external" />
              </ExternalLink>
            </li>
          ) : null}
          <li>
            <ExternalLink href={links.nws}>
              NWS forecast and alerts for the point <Icon name="external" />
            </ExternalLink>
          </li>
          <li>
            <ExternalLink href={links.iem}>
              IEM river forecast archive (Iowa State) <Icon name="external" />
            </ExternalLink>
          </li>
        </Links>
      </Section>
      {site.note ? <Muted>{site.note}</Muted> : null}
    </div>
  );
}

export type SiteDrawerProps = { evidence: SiteEvidence | null; onClose: () => void };

/** The right edge panel for the selected location (a bottom sheet on phones). */
export default function SiteDrawer({ evidence, onClose }: SiteDrawerProps) {
  return (
    <Panel side="right" title={evidence ? `${evidence.site.name} · ${evidence.site.lid}` : "Location"} open={evidence !== null} onClose={onClose} width={390} data-testid="carp-drawer-panel">
      {evidence ? <SiteDrawerView {...evidence} /> : null}
    </Panel>
  );
}
