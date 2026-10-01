import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { NOW, setupAgentEnv, type AgentEnv } from "./helpers";

import { agentSystemPrompt } from "@/server/agent/prompt";
import type { CapabilityContext } from "@/server/agent/runtime/registry";
import { buildAgentRegistry, CAPABILITY_NAMES } from "@/server/agent/tools/capabilities";
import { APP_IDS, getApp, parseAppConfig, type AppConfig } from "@/shared/apps";

/**
 * PLAN.md C-A5: persona, scope text, tool allowlist and refusal text come from the app config. The three configs
 * here are the test fixtures (tests/fixtures/apps); `stub` derives a config with a different allowlist.
 */

const FIXTURES = path.resolve(import.meta.dir, "../../fixtures/apps");
const raw = (id: string) => JSON.parse(readFileSync(path.join(FIXTURES, `${id}.json`), "utf8")) as Record<string, unknown>;
const stub = (id: string, agent: Partial<AppConfig["agent"]>): AppConfig => {
  const base = raw(id);
  return parseAppConfig({ ...base, agent: { ...(base.agent as object), ...agent } }, id);
};

let env: AgentEnv;
beforeAll(() => {
  env = setupAgentEnv();
});
afterAll(() => env.cleanup());

const ctxFor = (app: AppConfig): CapabilityContext => ({ app, now: NOW, emit: () => {} });

describe("agent per app", () => {
  for (const id of APP_IDS) {
    test(`agent per app: ${id}'s system prompt carries its persona, scope and refusal, and no other app's`, () => {
      const app = getApp(id);
      const prompt = agentSystemPrompt(app);
      expect(prompt.startsWith(app.agent.persona)).toBe(true);
      expect(prompt).toContain(app.agent.scope);
      expect(prompt).toContain(app.agent.refusal);
      for (const other of APP_IDS.filter((o) => o !== id)) {
        const o = getApp(other);
        expect(prompt).not.toContain(o.agent.scope);
        expect(prompt).not.toContain(o.agent.persona);
        expect(prompt).not.toContain(o.agent.refusal);
      }
    });

    test(`agent per app: ${id} registers exactly its allowlisted tools`, () => {
      const app = getApp(id);
      const names = buildAgentRegistry(app).list().map((cap) => cap.name);
      expect([...names].sort()).toEqual([...app.agent.tools].sort());
      for (const off of CAPABILITY_NAMES.filter((n) => !app.agent.tools.includes(n))) expect(names).not.toContain(off);
    });
  }

  test("agent per app: carp (conditions) has no species tools, and its prompt has no hotspot or species rules", async () => {
    const carp = getApp("carp");
    const registry = buildAgentRegistry(carp);
    for (const off of ["sightings", "species_counts", "hotspots", "explain_cell", "backtest"]) expect(registry.get(off)).toBeUndefined();
    expect(await registry.execute("hotspots", { species: "python" }, ctxFor(carp))).toEqual({ ok: false, code: "unknown", error: "Unknown capability: hotspots" });
    const prompt = agentSystemPrompt(carp);
    expect(prompt).not.toContain("## Hotspots");
    expect(prompt).not.toContain("## Species");
    expect(prompt).toContain("local time (America/Chicago)");
  });

  test("agent per app: a stub config without backtest does not register it; the model cannot call it", async () => {
    const tools = getApp("python").agent.tools.filter((t) => t !== "backtest");
    const app = stub("python", { tools });
    const registry = buildAgentRegistry(app);
    expect(registry.get("backtest")).toBeUndefined();
    expect(registry.get("hotspots")).toBeDefined();
    expect(await registry.execute("backtest", { species: "python" }, ctxFor(app))).toMatchObject({ ok: false, code: "unknown" });
    expect(agentSystemPrompt(app)).not.toContain("backtest to say how well");
  });

  test("agent per app: an allowlist naming a tool that does not exist is a config error", () => {
    expect(() => buildAgentRegistry(stub("lionfish", { tools: ["geocode", "teleport"] }))).toThrow("unknown tools: teleport");
  });

  test("agent per app: species enums are the app's (lionfish takes lionfish only)", async () => {
    const lionfish = getApp("lionfish");
    const registry = buildAgentRegistry(lionfish);
    const wrong = await registry.execute("hotspots", { species: "python" }, ctxFor(lionfish));
    expect(wrong).toMatchObject({ ok: false, code: "invalid_input" });
    const right = await registry.execute("hotspots", { species: "lionfish" }, ctxFor(lionfish));
    expect(right.ok).toBe(true);
  });

  test("agent per app: areas outside the app's regions get the app's refusal (P4)", async () => {
    const lionfish = getApp("lionfish");
    // Louisiana: carp's region, outside lionfish's four.
    const louisiana = { west: -92.5, south: 30.9, east: -92.3, north: 31.1 };
    const out = await buildAgentRegistry(lionfish).execute("alerts", { bbox: louisiana }, ctxFor(lionfish));
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining(lionfish.agent.refusal) });
    const carp = getApp("carp");
    const inside = await buildAgentRegistry(carp).execute("alerts", { bbox: louisiana }, ctxFor(carp));
    expect(inside.ok).toBe(true);
  });
});
