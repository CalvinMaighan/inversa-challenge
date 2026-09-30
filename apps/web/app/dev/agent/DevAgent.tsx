"use client";

import { useEffect, useState } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import AgentOrb from "client/agent";
import { registerGlobe, type CameraTarget } from "client/globe/api";
import { SELECTION, TIME } from "client/state";
import type { SelectionState } from "client/state/selection";
import { timeWindow, type TimeState } from "client/state/time";
import AppShell from "client/ui/AppShell";

/**
 * Stand-ins for the globe (T17) and evidence drawer (T18): a GlobeApi that records camera targets, and a
 * readout of SELECTION and TIME as data attributes the e2e asserts on.
 */
export default function DevAgent({ at }: { at: string | null }) {
  const [flights, setFlights] = useState<CameraTarget[]>([]);
  const [selection] = useActiveState<SelectionState>(SELECTION);
  const [time] = useActiveState<TimeState>(TIME);

  useEffect(() => {
    const atMs = at ? Date.parse(at) : NaN;
    if (Number.isFinite(atMs)) set<TimeState>(TIME, (prev) => ({ ...TIME.defaults, ...prev, ...timeWindow(atMs) }));
  }, [at]);

  useEffect(() => {
    registerGlobe({
      flyTo: (target) => setFlights((prev) => [...prev, target]),
      project: () => null,
      pick: () => null,
      onPostRender: () => () => {},
      requestRender: () => {},
    });
    return () => registerGlobe(null);
  }, []);

  const last = flights[flights.length - 1];
  return (
    <AppShell
      hud={
        <output
          data-dev-probe=""
          data-evidence-id={selection?.evidenceId ?? ""}
          data-drawer-open={selection?.drawerOpen ? "true" : "false"}
          data-fly-count={flights.length}
          data-time-at={time?.at ?? ""}
          style={{ position: "absolute", top: 12, left: 12, font: "12px/1.5 var(--font-mono)", color: "var(--muted)" }}
        >
          selection {selection?.evidenceId ?? "none"} · drawer {selection?.drawerOpen ? "open" : "closed"} · flights {flights.length}
          {last ? ` → ${last.lat.toFixed(3)}, ${last.lon.toFixed(3)}` : ""}
        </output>
      }
      orb={<AgentOrb />}
    />
  );
}
