"use client";

import styled, { keyframes } from "client/styled";

const drift = keyframes`
  from { transform: translate3d(0, 0, 0); opacity: 0; }
  15% { opacity: 1; }
  to { transform: translate3d(var(--dx), -110vh, 0); opacity: 0; }
`;

const Layer = styled.div`
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;

  i {
    position: absolute;
    bottom: -12px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #d8b46a;
    box-shadow: 0 0 10px 2px rgba(216, 180, 106, 0.8);
    animation: ${drift} var(--dur) linear var(--delay) infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    display: none;
  }
`;

/** Deterministic embers: the same on server and client. */
const EMBERS = Array.from({ length: 22 }, (_, i) => ({
  left: (i * 47 + 11) % 100,
  dx: ((i * 29) % 90) - 45,
  dur: 9 + ((i * 7) % 9),
  delay: -((i * 13) % 14),
}));

/**
 * The golden embers drifting up the page, on the black behind the globe: the shell draws it under the globe pane, so
 * they show around the map window and, through its soft edge, at its rim. The first-run gate blurs them with the rest
 * of the page; after the gate opens they stay.
 */
export default function Embers() {
  return (
    <Layer aria-hidden="true" data-embers="">
      {EMBERS.map((e, i) => (
        <i key={i} style={{ left: `${e.left}%`, ["--dx" as string]: `${e.dx}px`, ["--dur" as string]: `${e.dur}s`, ["--delay" as string]: `${e.delay}s` }} />
      ))}
    </Layer>
  );
}
