import { describe, expect, test } from "bun:test";

import { controlTools } from "@/server/agent/tools/map";
import { scopeGuard, scopeGuidance } from "@/server/agent/scope";
import type { AgentStreamEvent } from "@/shared/agent/events";
import { getApp } from "@/shared/apps";
import { parseUiCommand, UI_TOOL_NAMES } from "@/shared/voice/ui-tools";

const LION = getApp("lionfish");

describe("switch_app", () => {
  test("is a UI command with the three apps as its argument, for every app", () => {
    expect(UI_TOOL_NAMES).toContain("switch_app");
    for (const id of ["carp", "lionfish", "python"] as const) expect(parseUiCommand("switch_app", { app: id }, LION)).toEqual({ name: "switch_app", args: { app: id } });
    expect(parseUiCommand("switch_app", { app: "mars" }, LION)).toBeNull();
    expect(parseUiCommand("switch_app", {}, LION)).toBeNull();
  });

  test("every app's agent has the tool", () => {
    for (const id of ["carp", "lionfish", "python"] as const) expect(getApp(id).agent.tools).toContain("switch_app");
    expect(controlTools(LION).map((t) => t.name)).toContain("switch_app");
  });

  test("the tool sends the switch to the browser and tells the model what happened; the same app is a no-op", async () => {
    const tool = controlTools(LION).find((t) => t.name === "switch_app")!;
    const events: AgentStreamEvent[] = [];
    const ctx = { app: LION, now: new Date("2026-10-03T12:00:00Z"), emit: (e: AgentStreamEvent) => events.push(e) };
    const done = await tool.execute({ app: "carp" }, ctx as never);
    expect(events).toEqual([{ type: "ui", name: "switch_app", args: { app: "carp" } }]);
    expect(JSON.stringify(done)).toMatch(/switching to Carp Field Conditions/);
    events.length = 0;
    const same = await tool.execute({ app: "lionfish" }, ctx as never);
    expect(events).toEqual([]);
    expect(JSON.stringify(same)).toMatch(/Already on/);
  });

  test("a request to switch is not out of scope; a question about the other species still is", () => {
    for (const q of ["Can you select the carp?", "switch to the python app", "Go to lionfish", "take me to the Asian carp map"]) {
      expect([q, scopeGuard(LION, q)]).toEqual([q, null]);
    }
    expect(scopeGuidance(LION, "Where are Burmese pythons on Cozumel?")).not.toBeNull();
    expect(scopeGuard(getApp("carp"), "How many Burmese pythons were reported near Marathon?")).not.toBeNull();
  });
});
