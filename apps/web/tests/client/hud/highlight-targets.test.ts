import { describe, expect, test } from "bun:test";

import { MAX_HIGHLIGHT, placeTargets, targetPriority, wantedTargets } from "client/hud/overlay/targets";
import type { AgentHighlightTarget } from "client/state/agent";

const at = (i: number): AgentHighlightTarget => ({ id: `sighting:${i}`, label: `Green iguana · research`, lon: Number((-80.4 - i / 1000).toFixed(3)), lat: 25.5 });

describe("HUD brackets for the agent's highlight (PLAN.md C17)", () => {
  test("highlight: selection, citations and the answer's highlight merge without duplicates, strongest role kept", () => {
    const wanted = wantedTargets(
      "sighting:1",
      [
        ["sighting:2", "Green iguana · research · inat"],
        ["fetch:90410", "ndbc stale"],
      ],
      { targets: [at(1), at(2), at(3), { id: "alert:5001", label: "Cold Weather Advisory" }, { id: "backtest:python:7", label: "" }], hover: null },
    );
    // Drawing role: strongest wins. `highlight`: every id of the answer's highlight, whatever its role.
    expect(wanted.map((w) => [w.id, w.selected, w.cited, w.highlight])).toEqual([
      ["sighting:1", true, false, true],
      ["sighting:2", false, true, true],
      ["sighting:3", false, false, true],
      ["alert:5001", false, false, true],
    ]);
    // Positions the result carried travel with the id, even for the selected one; the alert has none.
    expect(wanted[0]!.at).toEqual({ lon: -80.401, lat: 25.5 });
    expect(wanted[2]!.at).toEqual({ lon: -80.403, lat: 25.5 });
    expect(wanted[3]!.at).toBeUndefined();
    expect(wanted[2]!.label).toBe("SIGHTING Green iguana · research");
  });

  test("highlight: capped at 50, and the hovered row joins even past the cap", () => {
    const targets = Array.from({ length: 70 }, (_, i) => at(i));
    const wanted = wantedTargets(null, [], { targets, hover: at(65) });
    expect(wanted.filter((w) => w.highlight)).toHaveLength(MAX_HIGHLIGHT + 1);
    expect(wanted.at(-1)).toMatchObject({ id: "sighting:65", hovered: true });
    expect(wantedTargets(null, [], { targets, hover: at(3) }).find((w) => w.id === "sighting:3")?.hovered).toBe(true);
  });

  test("highlight: placed with carried or looked-up positions; priorities rank selection, hover, citation, highlight", () => {
    const wanted = wantedTargets(null, [["sighting:9", "cited"]], { targets: [at(1), { id: "alert:5001", label: "" }], hover: null });
    const placed = placeTargets(wanted, new Map([["sighting:9", { lon: -80.1, lat: 25.6 }], ["alert:5001", null]]));
    expect(placed.map((t) => t.id)).toEqual(["sighting:9", "sighting:1"]);
    expect(placed[0]).toMatchObject({ cited: true, highlight: false });
    expect(placed[1]).toMatchObject({ highlight: true, cited: false, kind: "sighting", lon: -80.401, lat: 25.5 });
    const p = (w: { selected: boolean; hovered: boolean; cited: boolean }, i = 0) => targetPriority(w, i);
    const sel = p({ selected: true, hovered: false, cited: false });
    const hov = p({ selected: false, hovered: true, cited: false });
    const cite = p({ selected: false, hovered: false, cited: true }, 7);
    const hl0 = p({ selected: false, hovered: false, cited: false }, 0);
    const hl49 = p({ selected: false, hovered: false, cited: false }, 49);
    expect(sel > hov && hov > cite && cite > hl0 && hl0 > hl49).toBe(true);
  });
});
