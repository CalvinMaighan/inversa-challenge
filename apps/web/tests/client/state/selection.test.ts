import { describe, expect, test } from "bun:test";

import { parseEvidenceId, SELECTION } from "client/state/selection";

describe("SELECTION", () => {
  test("starts empty", () => {
    expect(SELECTION.defaults).toEqual({ evidenceId: null, drawerOpen: false });
    expect(SELECTION.evidenceId).toBe("SELECTION.evidenceId");
  });

  test("parseEvidenceId splits on the first colon only (PLAN.md C14)", () => {
    expect(parseEvidenceId("sighting:inat-123")).toEqual({ kind: "sighting", key: "inat-123" });
    expect(parseEvidenceId("reading:8723214:water_temp:1759262400000:ndbc")).toEqual({
      kind: "reading",
      key: "8723214:water_temp:1759262400000:ndbc",
    });
    expect(parseEvidenceId("hotspot:python:120:44:1759262400000")?.kind).toBe("hotspot");
    expect(parseEvidenceId("backtest:python:14")).toEqual({ kind: "backtest", key: "python:14" });
  });

  test("parseEvidenceId rejects unknown kinds and empty parts", () => {
    expect(parseEvidenceId("mission:1")).toBeNull();
    expect(parseEvidenceId("sighting:")).toBeNull();
    expect(parseEvidenceId(":1")).toBeNull();
    expect(parseEvidenceId("sighting")).toBeNull();
  });
});
