import { describe, expect, test } from "bun:test";

import { canonicalEvidenceId, parseEvidenceId, SELECTION } from "client/state/selection";

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
    // Field notes (T43) are board entities, not Axum evidence, but they carry C14 ids like everything else.
    expect(parseEvidenceId("note:0199a1b2-0001-7000-8000-000000000001")).toEqual({ kind: "note", key: "0199a1b2-0001-7000-8000-000000000001" });
  });

  test("parseEvidenceId rejects unknown kinds and empty parts", () => {
    expect(parseEvidenceId("mission:1")).toBeNull();
    expect(parseEvidenceId("sighting:")).toBeNull();
    expect(parseEvidenceId(":1")).toBeNull();
    expect(parseEvidenceId("sighting")).toBeNull();
  });
});

describe("canonicalEvidenceId", () => {
  test("a carp sighting written as a sighting id is the fish id; real sighting ids are left alone", () => {
    expect(canonicalEvidenceId("sighting:inat:405306600")).toBe("fish:inat:405306600");
    expect(canonicalEvidenceId("fish:inat:405306600")).toBe("fish:inat:405306600");
    expect(canonicalEvidenceId("sighting:4039")).toBe("sighting:4039");
    expect(canonicalEvidenceId("hotspot:lionfish:1:2:3")).toBe("hotspot:lionfish:1:2:3");
  });
});
