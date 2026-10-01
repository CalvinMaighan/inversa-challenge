"use client";

import { useMemo } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { LAYERS, setLayerVisible, setSpeciesVisible, type LayersState } from "client/state/layers";
import styled from "client/styled";
import { legendTitle } from "shared/apps";

import { useActiveApp } from "../appselect/use-active-app";
import { Mono } from "../primitives";
import AppIcon from "../appselect/AppIcon";
import { formatCount, GAP_SWATCHES, legendRows, type LegendRow, type LegendSwatch, type SwatchShape } from "./model";
import { useGlobeStats } from "./useGlobeStats";

/** The app's legend line (config `legend.title`). */
const LegendTitle = styled.p`
  margin: 0;
  padding-bottom: var(--gap-xs);
  color: var(--muted);
  font: 500 12px / 1.4 var(--font-ui);
`;

const Row = styled.div`
  padding: var(--gap-s) 0;
  border-bottom: 1px solid var(--border);

  /* An off layer dims its swatches and ramp, never its text (which keeps full contrast; the count reads "off"). */
  &[data-off] i {
    opacity: 0.45;
  }
`;

const RowHead = styled.label`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  font: 600 13px / 1.3 var(--font-ui);
  cursor: pointer;

  span {
    flex: 1;
    min-width: 0;
  }
`;

const Count = styled(Mono)`
  flex: none;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
`;

const Note = styled.p`
  margin: 3px 0 0 26px;
  color: var(--muted);
  font: 400 11.5px / 1.4 var(--font-ui);
`;

const Swatches = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 6px 0 0 26px;
  padding: 0;
  list-style: none;
`;

const Sub = styled.li`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  font: 400 12px / 1.5 var(--font-ui);

  label {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--gap-s);
    min-width: 0;
    cursor: pointer;
  }

  > [data-label] {
    flex: 1;
  }
`;

const Check = styled.input`
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
`;

const Swatch = styled.i<{ $color: string; $shape: SwatchShape }>`
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: ${(p) => (p.$shape === "dot" ? "50%" : "2px")};
  background: ${(p) =>
    p.$shape === "hatch"
      ? `repeating-linear-gradient(135deg, ${p.$color} 0 1.5px, transparent 1.5px 4px)`
      : p.$shape === "area"
        ? `color-mix(in srgb, ${p.$color} 30%, transparent)`
        : p.$color};
  /* Points and squares carry the globe's dark outline; areas and hatches their own colour. */
  border: ${(p) => (p.$shape === "area" || p.$shape === "hatch" ? `2px solid ${p.$color}` : "1.5px solid #0b0d12")};
  box-shadow: ${(p) => (p.$shape === "area" || p.$shape === "hatch" ? "none" : "0 0 0 1px var(--border)")};
  transform: ${(p) => (p.$shape === "diamond" ? "rotate(45deg) scale(0.8)" : "none")};
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
    margin-top: 2px;
    color: var(--muted);
    font: 400 11px / 1.3 var(--font-mono);
  }
`;

const ErrorNote = styled(Note)`
  color: var(--danger);
`;

/** A swatch: the app icon in the species colour (sightings) or a coloured shape. An off species reads dimmer, never grey. */
function SwatchMark({ swatch }: { swatch: LegendSwatch }) {
  if (swatch.shape === "icon" && swatch.icon) return <AppIcon icon={swatch.icon} color={swatch.color} size={16} />;
  return <Swatch $color={swatch.color} $shape={swatch.shape} aria-hidden="true" />;
}

function SwatchItem({ swatch, layerOn }: { swatch: LegendSwatch; layerOn: boolean }) {
  const count = swatch.count === null ? null : <Count data-testid={`legend-count-${swatch.key}`}>{formatCount(swatch.count)}</Count>;
  if (swatch.species) {
    const species = swatch.species;
    return (
      <Sub data-legend-swatch={swatch.key} style={swatch.on === false ? { opacity: 0.6 } : undefined}>
        <label>
          <Check type="checkbox" checked={swatch.on !== false} disabled={!layerOn} onChange={(e) => setSpeciesVisible(species, e.currentTarget.checked)} data-testid={`legend-species-${species}`} />
          <SwatchMark swatch={swatch} />
          {swatch.label}
        </label>
        {count}
      </Sub>
    );
  }
  return (
    <Sub data-legend-swatch={swatch.key}>
      <span style={{ marginLeft: swatch.shape === "dot" || swatch.shape === "icon" ? 24 : undefined, display: "inline-flex" }}>
        <SwatchMark swatch={swatch} />
      </span>
      <span data-label="">{swatch.label}</span>
      {count}
    </Sub>
  );
}

function LegendRowView({ row }: { row: LegendRow }) {
  return (
    <Row data-legend-layer={row.layer} data-off={row.visible ? undefined : ""}>
      <RowHead>
        <Check type="checkbox" role="switch" checked={row.visible} onChange={(e) => setLayerVisible(row.layer, e.currentTarget.checked)} aria-label={`Show ${row.label}`} data-testid={`legend-toggle-${row.layer}`} />
        <span>{row.label}</span>
        <Count data-testid={`legend-count-${row.layer}`} title={`${formatCount(row.count)} ${row.unit}`}>
          {row.visible ? `${formatCount(row.count)} ${row.unit}` : "off"}
        </Count>
      </RowHead>
      <Note>{row.note}</Note>
      {row.swatches.length > 0 ? (
        <Swatches>
          {row.swatches.map((s) => (
            <SwatchItem key={s.key} swatch={s} layerOn={row.visible} />
          ))}
        </Swatches>
      ) : null}
      {row.ramp ? (
        <Ramp aria-label={`${row.label} colour scale, ${row.ramp.min} to ${row.ramp.max}`}>
          <i style={{ background: row.ramp.css }} />
          <div>
            <span>{row.ramp.min}</span>
            <span>{row.ramp.caption}</span>
            <span>{row.ramp.max}</span>
          </div>
        </Ramp>
      ) : null}
      {row.error && row.visible ? <ErrorNote role="status">Not loading: {row.error}</ErrorNote> : null}
    </Row>
  );
}

function GapsRow() {
  return (
    <Row data-legend-layer="gaps">
      <RowHead as="div">
        <span>Data gaps</span>
      </RowHead>
      <Note>Hatching means missing data, never zero: nothing is interpolated across a gap.</Note>
      <Swatches>
        {GAP_SWATCHES.map((g) => (
          <Sub key={g.key} data-legend-swatch={g.key} title={g.where}>
            <Swatch $color={g.color} $shape="hatch" aria-hidden="true" />
            <span data-label="">
              {g.label} <small style={{ color: "var(--muted)" }}>· {g.where}</small>
            </span>
          </Sub>
        ))}
      </Swatches>
    </Row>
  );
}

/**
 * Layers and legend (T40, T41): what every colour on the globe means, a switch per layer and per species, and
 * what each layer draws right now (GlobeApi `stats()`). Lives in the About popover under "More data (for
 * experts)"; the species chip is the everyday filter. Samples the globe only while `active` (the section open).
 */
export default function LegendBody({ active }: { active: boolean }) {
  const layers = useActiveState<LayersState>(LAYERS)[0] ?? LAYERS.defaults;
  const stats = useGlobeStats(active);
  const app = useActiveApp();
  const rows = useMemo(() => legendRows({ ...LAYERS.defaults, ...layers }, stats, app), [app, layers, stats]);
  const title = legendTitle(app);
  return (
    <section aria-label="Layers and legend" data-testid="layers-legend" data-app={app.id}>
      {title ? <LegendTitle data-testid="legend-title">{title}</LegendTitle> : null}
      {rows.map((row) => (
        <LegendRowView key={row.layer} row={row} />
      ))}
      <GapsRow />
    </section>
  );
}
