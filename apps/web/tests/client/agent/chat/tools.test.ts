import { describe, expect, test } from "bun:test";

import { formatWorkDuration, groupDetail, groupLabel, groupState, groupTools, toolLabel, turnWorkMs } from "client/agent/chat/tools";
import type { AgentToolRow } from "client/agent/chat/thread";

const row = (toolCallId: string, capabilityName: string, state: AgentToolRow["state"], extra: Partial<AgentToolRow> = {}): AgentToolRow => ({
  toolCallId,
  capabilityName,
  state,
  ...extra,
});

describe("tool timeline", () => {
  test("completed calls group per capability in first-seen order; running calls stay separate", () => {
    const { groups, running } = groupTools([
      row("1", "geocode", "ok", { count: 1 }),
      row("2", "sightings", "ok", { count: 3, evidence: 3 }),
      row("3", "sightings", "error", { error: "GraphQL 502" }),
      row("4", "conditions", "running"),
      row("5", "geocode", "ok", { count: 1 }),
    ]);
    expect(groups.map((g) => [g.capabilityName, g.items.length])).toEqual([
      ["geocode", 2],
      ["sightings", 2],
    ]);
    expect(running.map((t) => t.toolCallId)).toEqual(["4"]);
    expect(groups.map(groupLabel)).toEqual(["Found 2 places", "Searched sightings 2 times"]);
    expect(groups.map(groupState)).toEqual(["ok", "error"]);
    expect(groupDetail(groups[1]!)).toBe("3 rows, 3 evidence · GraphQL 502");
    expect(groupDetail(groups[0]!)).toBe("1 row · 1 row");
  });

  test("labels: running gets an ellipsis, unknown capabilities show their name", () => {
    expect(toolLabel({ capabilityName: "hotspots", state: "running" })).toBe("Ranking hotspots…");
    expect(toolLabel({ capabilityName: "hotspots", state: "ok" })).toBe("Ranked hotspots");
    expect(toolLabel({ capabilityName: "mystery", state: "ok" })).toBe("mystery");
    expect(groupLabel({ capabilityName: "alerts", items: [row("a", "alerts", "ok"), row("b", "alerts", "ok")] })).toBe("Checked NWS alerts ×2");
  });

  test("Worked for durations", () => {
    expect(formatWorkDuration(0, false)).toBe("1s");
    expect(formatWorkDuration(0, true)).toBe("0s");
    expect(formatWorkDuration(12_400, false)).toBe("12s");
    expect(formatWorkDuration(12_900, true)).toBe("12s");
    expect(formatWorkDuration(59_600, false)).toBe("1m00s");
    expect(formatWorkDuration(64_000, false)).toBe("1m04s");
  });

  test("turn clock runs to now while streaming and stops at endedAt", () => {
    expect(turnWorkMs({ startedAtMs: 1_000 }, 4_000)).toBe(3_000);
    expect(turnWorkMs({ startedAtMs: 1_000, endedAtMs: 2_500 }, 9_000)).toBe(1_500);
    expect(turnWorkMs({}, 9_000)).toBe(0);
  });
});
