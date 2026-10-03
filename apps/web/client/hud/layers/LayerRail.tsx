"use client";

import { useId, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { setFishVisible, useFish } from "client/carp/fish";
import { overlayRows, type OverlayRow } from "client/globe/layers/overlays/legend";
import { overlayOpacity, setOverlayOpacity, subscribeOverlayOpacity } from "client/globe/layers/overlays/opacity";
import { isSurveyApp } from "client/lionfish/model";
import { REEF_MODES, REEF_SPECS } from "client/lionfish/reef";
import { setView, useView } from "client/lionfish/store";
import { LAYERS, setLayerVisible, type LayersState } from "client/state/layers";
import styled from "client/styled";
import { hasLayer, LAYER_IDS, type AppConfig } from "shared/apps";
import { SIGHTING_WINDOW_OPTIONS, windowLabel } from "shared/frames";

import { useActiveApp } from "../appselect/use-active-app";
import { GLASS_CSS, POPOVER_BUTTONS_CSS, Surface } from "../primitives";
import { usePopover } from "../topbar/TopBar";

const SIGHTINGS = LAYER_IDS[0];
const SST_MAP = LAYER_IDS[10];

/**
 * The layer rail (right edge of the map): one round button for every layer that is on, its icon standing for the layer,
 * and a small popover with that layer's own setting and a way to switch it off. Nothing is on at first but sightings, so
 * the rail starts with one button and grows as layers are turned on in the Layers panel.
 */
const Rail = styled.div`
  position: absolute;
  z-index: 3;
  right: max(var(--gap-m), env(safe-area-inset-right));
  top: var(--hud-top);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--gap-s);
  pointer-events: none;

  > * {
    pointer-events: auto;
  }
`;

const Item = styled.div`
  position: relative;
`;

const Button = styled(Surface.withComponent("button"))`
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  color: var(--text);
  cursor: pointer;

  svg {
    width: 17px;
    height: 17px;
  }

  &:hover,
  &[aria-expanded="true"] {
    border-color: var(--hud-line);
  }
`;

const Pop = styled.div`
  position: absolute;
  right: calc(100% + var(--gap-s));
  top: 0;
  z-index: 9;
  width: min(260px, calc(100cqw - 80px));
  padding: var(--gap-m);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  ${GLASS_CSS}
  color: var(--text);
  font: 400 13px / 1.45 var(--font-ui);
  ${POPOVER_BUTTONS_CSS}

  &:focus-visible {
    outline-offset: -2px;
  }

  h3 {
    margin: 0 0 2px;
    font: 600 13px / 1.3 var(--font-ui);
  }

  p {
    margin: 0 0 var(--gap-s);
    color: var(--muted);
    font-size: 12px;
  }
`;

const Setting = styled.label`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  margin-bottom: var(--gap-s);
  font: 400 12px / 1.4 var(--font-ui);

  input[type="range"] {
    flex: 1;
    accent-color: var(--accent);
  }
`;

const Chips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: var(--gap-s);

  button {
    padding: 4px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-round);
    background: transparent;
    color: var(--muted);
    font: 600 11px / 1.2 var(--font-ui);
    cursor: pointer;
  }
  button[aria-pressed="true"] {
    border-color: var(--accent);
    background: color-mix(in oklch, var(--accent) 22%, transparent);
    color: var(--text);
  }
`;

const Off = styled.button`
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  font: 600 11px / 1 var(--font-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
`;

type IconProps = { children: ReactNode };
const Icon = ({ children }: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** One small drawing per layer, by layer id (the reef heat map is `reef`). */
const ICONS: Record<string, ReactNode> = {
  [SIGHTINGS]: (
    <Icon>
      <path d="M8 14s4.5-3.9 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 10.1 8 14 8 14Z" />
      <circle cx="8" cy="6.5" r="1.6" />
    </Icon>
  ),
  reef: (
    <Icon>
      <path d="M2 11c1.5-1.4 3-1.4 4.5 0S9.5 12.4 11 11s3-1.4 3 0" />
      <path d="M5 8.5V4M8 8V2.5M11 8.5V5" />
    </Icon>
  ),
  [SST_MAP]: (
    <Icon>
      <path d="M7 2.5a1.5 1.5 0 0 1 3 0V9a3 3 0 1 1-3 0Z" transform="translate(-1.5 0)" />
      <path d="M12 4h2M12 7h2M12 10h2" />
    </Icon>
  ),
  radar: (
    <Icon>
      <path d="M4.5 10.5a3 3 0 0 1 .4-5.9 3.8 3.8 0 0 1 7.2 1.4 2.4 2.4 0 0 1-.5 4.5Z" />
      <path d="M6 13l.6-1.4M9 13l.6-1.4" />
    </Icon>
  ),
  lightning: (
    <Icon>
      <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8Z" />
    </Icon>
  ),
  cyclones: (
    <Icon>
      <path d="M8 8.2a.4.4 0 1 1 .01 0M8 5a3 3 0 0 1 3 3 4.6 4.6 0 0 1-4.6 4.6A5.8 5.8 0 0 1 2 8 6 6 0 0 1 8 2" />
    </Icon>
  ),
};

type Active = { id: string; label: string; blurb: string; body: ReactNode; off: () => void };

function OpacitySetting() {
  const value = useSyncExternalStore(subscribeOverlayOpacity, overlayOpacity, overlayOpacity);
  return (
    <Setting>
      <span>Opacity</span>
      <input type="range" min={0.05} max={1} step={0.05} value={value} onChange={(e) => setOverlayOpacity(Number(e.currentTarget.value))} aria-label="Overlay opacity" />
      <span>{Math.round(value * 100)}%</span>
    </Setting>
  );
}

function RailButton({ layer }: { layer: Active }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pop = usePopover(triggerRef, popRef);
  const id = useId();
  return (
    <Item data-rail-layer={layer.id}>
      <Button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={pop.open} aria-controls={pop.open ? id : undefined} aria-label={`${layer.label}: on. Settings`} title={`${layer.label}: settings`} onClick={pop.toggle}>
        {ICONS[layer.id]}
      </Button>
      {pop.open ? (
        <Pop
          ref={popRef}
          id={id}
          role="dialog"
          aria-label={layer.label}
          tabIndex={-1}
          data-hud-obstacle=""
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              pop.close();
            }
          }}
        >
          <h3>{layer.label}</h3>
          <p>{layer.blurb}</p>
          {layer.body}
          <Off
            type="button"
            onClick={() => {
              pop.close();
              layer.off();
            }}
          >
            Turn off
          </Off>
        </Pop>
      ) : null}
    </Item>
  );
}

/** The layers that are on, in the order of the Layers panel: sightings, the reef heat map, then the water and weather overlays. */
export function activeLayers(app: AppConfig, layers: LayersState, reef: { heat: boolean; mode: (typeof REEF_MODES)[number] }, fishOn: boolean): Active[] {
  const out: Active[] = [];
  if (hasLayer(app, SIGHTINGS) ? layers.visible[SIGHTINGS] !== false : app.kind === "conditions" && fishOn) {
    out.push({
      id: SIGHTINGS,
      label: "Sightings",
      blurb: "Where people reported the species. Click a dot to see the record.",
      body:
        app.kind === "conditions" ? null : (
          <Chips role="group" aria-label="How far back dots show">
            {SIGHTING_WINDOW_OPTIONS.map((h) => (
              <button key={h} type="button" aria-pressed={layers.sightingHours === h} onClick={() => setSightingHours(h)}>
                {windowLabel(h)}
              </button>
            ))}
          </Chips>
        ),
      off: () => (hasLayer(app, SIGHTINGS) ? setLayerVisible(SIGHTINGS, false) : setFishVisible(false)),
    });
  }
  if (isSurveyApp(app) && reef.heat) {
    out.push({
      id: "reef",
      label: "Reef heat map",
      blurb: REEF_SPECS[reef.mode].blurb,
      body: (
        <Chips role="group" aria-label="Which heat map">
          {REEF_MODES.map((m) => (
            <button key={m} type="button" aria-pressed={reef.mode === m} onClick={() => setView({ reef: m })}>
              {REEF_SPECS[m].label}
            </button>
          ))}
        </Chips>
      ),
      off: () => setView({ heat: false }),
    });
  }
  for (const row of overlayRows(app, layers, null).filter((r: OverlayRow) => r.visible)) {
    out.push({ id: row.id, label: row.label, blurb: row.blurb, body: <OpacitySetting />, off: () => setLayerVisible(row.id, false) });
  }
  return out;
}

function setSightingHours(hours: LayersState["sightingHours"]): void {
  // Same key the Layers legend and the agent write.
  set<LayersState>(LAYERS, (prev = LAYERS.defaults) => ({ ...prev, sightingHours: hours }));
}

/** The rail itself. Nothing renders while no layer is on. */
export default function LayerRail() {
  const app = useActiveApp();
  const stored = useActiveState<LayersState>(LAYERS)[0];
  const layers = useMemo(() => ({ ...LAYERS.defaults, ...stored }), [stored]);
  const view = useView();
  const fish = useFish();
  const active = activeLayers(app, layers, { heat: view.heat, mode: view.reef }, fish.visible);
  if (active.length === 0) return null;
  return (
    <Rail data-testid="layer-rail" aria-label="Layers that are on">
      {active.map((l) => (
        <RailButton key={l.id} layer={l} />
      ))}
    </Rail>
  );
}
