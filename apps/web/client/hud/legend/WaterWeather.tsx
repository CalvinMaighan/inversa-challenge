"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { get, subscribe } from "@calvinjs/active-state";

import { getGlobe } from "client/globe/api";
import { activeAttributions, GROUP_LABEL, overlayRows, rampCss, type OverlayRow } from "client/globe/layers/overlays/legend";
import { overlayOpacity, setOverlayOpacity, subscribeOverlayOpacity } from "client/globe/layers/overlays/opacity";
import type { LayerStats } from "client/globe/layers/types";
import ExternalLink from "client/external-link";
import { LAYERS, setLayerVisible, type LayersState } from "client/state/layers";
import styled from "client/styled";
import type { AppConfig } from "shared/apps";

import { Mono } from "../primitives";

const Group = styled.section`
  margin-top: var(--gap-s);
  padding-top: var(--gap-s);
  border-top: 1px solid var(--border);

  > h4 {
    margin: 0 0 2px;
    color: var(--muted);
    font: 600 12px / 1.6 var(--font-ui);
  }

  > p {
    margin: 0 0 var(--gap-xs);
    color: var(--muted);
    font: 400 11.5px / 1.4 var(--font-ui);
  }
`;

const Row = styled.div`
  padding: var(--gap-s) 0;
  border-bottom: 1px solid var(--border);

  &[data-off] i {
    opacity: 0.45;
  }
`;

const Head = styled.label`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  font: 600 13px / 1.3 var(--font-ui);
  cursor: pointer;

  span {
    flex: 1;
    min-width: 0;
  }

  input {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
`;

const Note = styled.p`
  margin: 3px 0 0 26px;
  color: var(--muted);
  font: 400 11.5px / 1.4 var(--font-ui);
`;

const Shown = styled(Mono)`
  display: block;
  margin: 3px 0 0 26px;
  color: var(--text);
  font-size: 11px;
`;

const Ramp = styled.div`
  margin: 6px 0 0 26px;

  i {
    display: block;
    height: 10px;
    border-radius: 3px;
    border: 1px solid var(--border);
  }

  div {
    display: flex;
    justify-content: space-between;
    gap: var(--gap-s);
    margin-top: 2px;
    color: var(--muted);
    font: 400 11px / 1.3 var(--font-mono);
  }
`;

const Swatches = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 6px 0 0 26px;
  padding: 0;
  list-style: none;
  font: 400 12px / 1.5 var(--font-ui);

  li {
    display: flex;
    align-items: center;
    gap: var(--gap-s);
  }

  i {
    flex: none;
    width: 12px;
    height: 12px;
    border-radius: 2px;
    border: 1px solid var(--border);
  }
`;

const Opacity = styled.label`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  margin-top: var(--gap-s);
  font: 400 12px / 1.4 var(--font-ui);

  input {
    flex: 1;
    accent-color: var(--accent);
  }
`;

const Credits = styled.ul`
  margin: var(--gap-s) 0 0;
  padding: 0;
  list-style: none;
  color: var(--muted);
  font: 400 11px / 1.4 var(--font-ui);
`;

const ErrorNote = styled(Note)`
  color: var(--danger);
`;

const subscribeLayers = (cb: () => void) => subscribe(LAYERS, cb);
/** The stored object itself (a stable snapshot); defaults are merged where it is read. */
const readLayers = (): LayersState | undefined => get<LayersState>(LAYERS);

/** LAYERS with a server snapshot, so the group renders under SSR and in markup tests. */
function useLayersState(): LayersState | undefined {
  return useSyncExternalStore(subscribeLayers, readLayers, readLayers);
}

/** The globe's stats for these rows: polled while the group is open (the shown time changes without a count change). */
function useOverlayStats(active: boolean): LayerStats[] | null {
  const [stats, setStats] = useState<LayerStats[] | null>(null);
  useEffect(() => {
    if (!active) return;
    let last = "";
    const tick = () => {
      const next = getGlobe()?.stats?.() ?? null;
      const sig = next ? next.map((s) => `${s.id}:${s.enabled ? 1 : 0}:${s.count}:${s.error ?? ""}:${s.overlay?.shownMs ?? ""}:${s.overlay?.clamped ?? ""}:${s.breakdown?.loaded ?? ""}`).join("|") : "";
      if (sig === last) return;
      last = sig;
      setStats(next);
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [active]);
  return stats;
}

function OverlayRowView({ row }: { row: OverlayRow }) {
  return (
    <Row data-legend-layer={row.id} data-overlay-row={row.id} data-off={row.visible ? undefined : ""}>
      <Head>
        <input type="checkbox" role="switch" checked={row.visible} onChange={(e) => setLayerVisible(row.id, e.currentTarget.checked)} aria-label={`Show ${row.label}`} data-testid={`legend-toggle-${row.id}`} />
        <span>{row.label}</span>
      </Head>
      <Note data-testid={`overlay-blurb-${row.id}`}>{row.blurb}</Note>
      {row.legend.kind === "ramp" ? (
        <Ramp aria-label={`${row.label} colour scale, ${row.legend.min} to ${row.legend.max}`}>
          <i style={{ background: rampCss(row.legend) }} />
          <div>
            <span>{row.legend.min}</span>
            <span>{row.legend.unit}</span>
            <span>{row.legend.max}</span>
          </div>
        </Ramp>
      ) : (
        <Swatches>
          {row.legend.items.map((item) => (
            <li key={item.label}>
              <i style={{ background: item.color }} aria-hidden="true" />
              <span>{item.label}</span>
            </li>
          ))}
        </Swatches>
      )}
      {row.shown ? <Shown data-testid={`overlay-shown-${row.id}`}>{row.shown}</Shown> : null}
      {row.note ? <Note data-testid={`overlay-note-${row.id}`}>{row.note}</Note> : null}
      {row.error && row.visible ? <ErrorNote role="status">Not loading: {row.error}</ErrorNote> : null}
    </Row>
  );
}

/**
 * "Water and weather" (docs/GODS_EYE.md GC5, GC6): the overlays the app lists, off by default, each with one
 * plain line, a legend with units, the instant it shows, one opacity slider for all of them, and the attribution
 * of every source that is on. Renders nothing for an app that lists none.
 */
export default function WaterWeather({ app, active = true, stats: given }: { app: AppConfig; active?: boolean; stats?: LayerStats[] | null }) {
  const layers = useLayersState() ?? LAYERS.defaults;
  const polled = useOverlayStats(active && given === undefined);
  const stats = given === undefined ? polled : given;
  const rows = useMemo(() => overlayRows(app, { ...LAYERS.defaults, ...layers }, stats), [app, layers, stats]);
  const opacity = useSyncExternalStore(subscribeOverlayOpacity, overlayOpacity, overlayOpacity);
  if (rows.length === 0) return null;
  const credits = activeAttributions(rows);
  return (
    <Group aria-label={GROUP_LABEL} data-testid="water-weather">
      <h4>{GROUP_LABEL}</h4>
      <p>Live pictures from NOAA and NASA. They follow the timeline: each one shows the nearest moment its source has.</p>
      {rows.map((row) => (
        <OverlayRowView key={row.id} row={row} />
      ))}
      <Opacity>
        <span>Opacity</span>
        <input type="range" min={0.05} max={1} step={0.05} value={opacity} onChange={(e) => setOverlayOpacity(Number(e.currentTarget.value))} aria-label="Water and weather overlay opacity" data-testid="overlay-opacity" />
        <Mono>{Math.round(opacity * 100)}%</Mono>
      </Opacity>
      {credits.length > 0 ? (
        <Credits aria-label="Overlay attribution" data-testid="overlay-attribution">
          {credits.map((c) => (
            <li key={c.attribution}>
              <ExternalLink href={c.sourceUrl}>{c.attribution}</ExternalLink>
            </li>
          ))}
        </Credits>
      ) : null}
    </Group>
  );
}
