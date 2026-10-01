"use client";

import { useMemo, useRef } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { LAYERS, setLayerSpeciesPin, setLayerVisible, setSpeciesVisible, type LayersState, type SpeciesId } from "client/state/layers";
import styled from "client/styled";
import { SPECIES_IDS } from "shared/voice/ui-tools";

import { Icon, IconButton, Mono, NARROW_PANE } from "../primitives";
import { SPECIES_NAMES } from "../tooltip/model";
import { formatCount, GAP_SWATCHES, legendRows, type LegendRow, type LegendSwatch, type SwatchShape } from "./model";
import { useGlobeStats } from "./useGlobeStats";

const Anchor = styled.div`
  position: absolute;
  z-index: 5;
  top: var(--hud-top);
  right: var(--hud-right, var(--gap-m));
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-height: calc(100% - var(--hud-top) - var(--hud-bottom) - var(--gap-s));
  pointer-events: none;

  & > * {
    pointer-events: auto;
  }

  /* A narrow pane cannot fit the drawer and the legend side by side: the legend moves to the left edge. */
  ${NARROW_PANE} {
    [data-drawer-open] & {
      right: auto;
      left: max(var(--gap-m), env(safe-area-inset-left));
      align-items: flex-start;
    }
  }
`;

const Toggle = styled(IconButton)`
  background: var(--surface);
  box-shadow: var(--shadow);
`;

const Sheet = styled.section`
  display: flex;
  flex-direction: column;
  width: min(320px, calc(100cqw - 2 * var(--gap-m)));
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow);
  color: var(--text);
`;

const Head = styled.header`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  padding: 6px 6px 6px var(--gap-m);
  border-bottom: 1px solid var(--border);

  h2 {
    flex: 1;
    margin: 0;
    font: 600 var(--font-xs) / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text);
  }
`;

const Body = styled.div`
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
`;

const Row = styled.div`
  padding: var(--gap-s) var(--gap-m);
  border-bottom: 1px solid var(--border);

  &[data-off] > :not(:first-child) {
    opacity: 0.55;
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

const Pin = styled.label`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  margin: 6px 0 0 26px;
  color: var(--muted);
  font: 400 12px / 1.3 var(--font-ui);

  select {
    flex: 1;
    min-width: 0;
    padding: 2px 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }
`;

const ErrorNote = styled(Note)`
  color: var(--danger);
`;

function SwatchItem({ swatch, layerOn }: { swatch: LegendSwatch; layerOn: boolean }) {
  const count = swatch.count === null ? null : <Count data-testid={`legend-count-${swatch.key}`}>{formatCount(swatch.count)}</Count>;
  if (swatch.species) {
    const species = swatch.species;
    return (
      <Sub data-legend-swatch={swatch.key}>
        <label>
          <Check type="checkbox" checked={swatch.on !== false} disabled={!layerOn} onChange={(e) => setSpeciesVisible(species, e.currentTarget.checked)} data-testid={`legend-species-${species}`} />
          <Swatch $color={swatch.color} $shape={swatch.shape} aria-hidden="true" />
          {swatch.label}
        </label>
        {count}
      </Sub>
    );
  }
  return (
    <Sub data-legend-swatch={swatch.key}>
      <Swatch $color={swatch.color} $shape={swatch.shape} aria-hidden="true" style={{ marginLeft: swatch.shape === "dot" ? 24 : undefined }} />
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
      {row.pin !== undefined ? (
        <Pin>
          Species
          <select
            value={row.pin ?? ""}
            onChange={(e) => setLayerSpeciesPin(row.layer, (e.currentTarget.value || null) as SpeciesId | null)}
            data-testid={`legend-pin-${row.layer}`}
          >
            <option value="">All shown species</option>
            {SPECIES_IDS.map((id, i) => (
              <option key={id} value={id}>
                {SPECIES_NAMES[i]} only
              </option>
            ))}
          </select>
        </Pin>
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
 * Layers and legend (T40), top right of the globe pane: what every colour on the globe means, a switch per
 * layer and per species, and what each layer draws right now (GlobeApi `stats()`).
 */
export default function LegendPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const layers = useActiveState<LayersState>(LAYERS)[0] ?? LAYERS.defaults;
  const stats = useGlobeStats(open);
  const rows = useMemo(() => legendRows({ ...LAYERS.defaults, ...layers }, stats), [layers, stats]);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Closing from inside the sheet (Esc, its close button) would drop focus on <body>: hand it back to Layers.
  const closeFromInside = () => {
    onOpenChange(false);
    toggleRef.current?.focus({ preventScroll: true });
  };
  return (
    <Anchor data-hud-obstacle="" data-testid="hud-legend">
      <Toggle ref={toggleRef} type="button" $active={open} aria-expanded={open} aria-controls="layers-legend" onClick={() => onOpenChange(!open)} data-testid="layers-button" title="Layers and legend">
        <Icon name="layers" />
        Layers
      </Toggle>
      {open ? (
        <Sheet
          id="layers-legend"
          aria-label="Layers and legend"
          data-testid="layers-legend"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              closeFromInside();
            }
          }}
        >
          <Head>
            <h2>Layers & legend</h2>
            <IconButton type="button" aria-label="Close layers" onClick={closeFromInside}>
              <Icon name="close" />
            </IconButton>
          </Head>
          <Body>
            {rows.map((row) => (
              <LegendRowView key={row.layer} row={row} />
            ))}
            <GapsRow />
          </Body>
        </Sheet>
      ) : null}
    </Anchor>
  );
}
