"use client";

import styled from "client/styled";

import { setView, useView } from "./store";
import { BAA_CLASSES, RAINBOW, REEF_MODES, REEF_SPECS } from "./reef";

/**
 * The reef heat map as a row of the Layers popover (the lionfish app): a switch, the four maps to pick from (one at a
 * time, so a colour always means one thing) and the legend of the chosen one.
 */
const Row = styled.div`
  padding: var(--gap-s) 0;
  border-bottom: 1px solid var(--border);
`;

const Head = styled.label`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  font: 600 13px / 1.3 var(--font-ui);
  cursor: pointer;

  input {
    flex: none;
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  span {
    flex: 1;
    min-width: 0;
  }
`;

const Note = styled.p`
  margin: 3px 0 0 26px;
  color: var(--muted);
  font: 400 11.5px / 1.4 var(--font-ui);
`;

const Modes = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px;
  margin: 8px 0 0 26px;

  button {
    height: 28px;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--muted);
    font: 600 11.5px / 1 var(--font-ui);
    white-space: nowrap;
    cursor: pointer;
  }
  button:hover {
    color: var(--text);
    border-color: var(--hud-line);
  }
  button[aria-pressed="true"] {
    color: var(--text);
    border-color: var(--accent);
    background: color-mix(in oklch, var(--accent) 18%, transparent);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
`;

const Legend = styled.div`
  margin: 8px 0 0 26px;
  color: var(--muted);
  font: 500 10.5px / 1.2 var(--font-mono);

  .ramp {
    height: 8px;
    border-radius: 4px;
  }
  .ends {
    display: flex;
    justify-content: space-between;
    margin-top: 3px;
  }
  ul {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li i {
    display: block;
    height: 8px;
    margin-bottom: 3px;
  }
`;

export default function ReefLayerRow() {
  const view = useView();
  const spec = REEF_SPECS[view.reef];
  return (
    <Row data-testid="reef-controls" data-legend-layer="reef">
      <Head>
        <input type="checkbox" role="switch" checked={view.heat} onChange={(e) => setView({ heat: e.currentTarget.checked })} aria-label="Show reef heat map" data-testid="reef-toggle" />
        <span>Reef heat map</span>
      </Head>
      <Note>NOAA Coral Reef Watch, one picture a day, following the timeline.</Note>
      {view.heat ? (
        <>
          <Modes role="group" aria-label="Which heat map">
            {REEF_MODES.map((m) => (
              <button key={m} type="button" aria-pressed={view.reef === m} data-reef={m} onClick={() => setView({ reef: m })}>
                {REEF_SPECS[m].label}
              </button>
            ))}
          </Modes>
          <Legend aria-label={`${spec.label} colour scale`}>
            {spec.discrete ? (
              <ul>
                {BAA_CLASSES.map((c) => (
                  <li key={c.label}>
                    <i style={{ background: c.color }} aria-hidden="true" />
                    {c.label}
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <div className="ramp" style={{ background: `linear-gradient(90deg, ${RAINBOW.join(", ")})` }} aria-hidden="true" />
                <div className="ends">
                  <span>{spec.low}</span>
                  <span>{spec.unit}</span>
                  <span>{spec.high}</span>
                </div>
              </>
            )}
          </Legend>
          <Note>{spec.blurb}</Note>
        </>
      ) : null}
    </Row>
  );
}
