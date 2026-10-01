import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { NOW, setupAgentEnv, type AgentEnv } from "./helpers";

import { buildAgentRegistry } from "@/server/agent/tools/capabilities";
import { fetchFeeds, graphqlUrl } from "@/server/agent/tools/gql";
import { APP_IDS, appBBox, getApp, speciesIds, type AppId } from "@/shared/apps";

/**
 * PLAN.md C-A2/C-A5: every agent tool request goes to `/v1/<app>/graphql`. The fixture stub 404s anything else
 * (the old `/v1/graphql` included), and records each request's path, so a tool that forgot the prefix fails here.
 */

let env: AgentEnv;
beforeAll(() => {
  env = setupAgentEnv();
});
afterAll(() => env.cleanup());

/** Arguments that make each tool reach the API. */
function argsFor(tool: string, app: AppId): Record<string, unknown> | null {
  const species = speciesIds(getApp(app))[0];
  switch (tool) {
    case "sightings":
    case "species_counts":
    case "conditions":
    case "alerts":
    case "feed_state":
    case "notes":
      return {};
    case "hotspots":
    case "backtest":
      return species ? { species } : null;
    case "explain_cell":
      return species ? { species, cell: "10:10" } : null;
    default:
      return null; // geocode (gazetteer) and set_view make no API call
  }
}

describe("app prefix", () => {
  test("app prefix: the agent's GraphQL URL is /v1/<app>/graphql for every app", () => {
    for (const id of APP_IDS) expect(new URL(graphqlUrl({ id })).pathname).toBe(`/v1/${id}/graphql`);
  });

  for (const id of APP_IDS) {
    test(`app prefix: every ${id} tool request carries /v1/${id}/`, async () => {
      const app = getApp(id);
      const registry = buildAgentRegistry(app);
      env.stub.requests.length = 0;
      let called = 0;
      for (const cap of registry.list()) {
        const args = argsFor(cap.name, id);
        if (!args) continue;
        called += 1;
        await registry.execute(cap.name, args, { app, now: NOW, emit: () => {}, view: { bbox: appBBox(app), time: NOW.toISOString(), layers: [], selection: null } });
      }
      await fetchFeeds({ app });
      expect(called).toBeGreaterThan(0);
      expect(env.stub.requests.length).toBeGreaterThan(called);
      const paths = new Set(env.stub.requests.map((r) => r.path));
      expect([...paths]).toEqual([`/v1/${id}/graphql`]);
      expect(env.stub.requests.every((r) => r.app === id)).toBe(true);
    });
  }

  test("app prefix: the stub (like Axum after C-A2) refuses the unprefixed route and unknown apps", async () => {
    const unprefixed = await fetch(`${env.stub.origin}/v1/graphql`, { method: "POST", body: "{}" });
    expect(unprefixed.status).toBe(404);
    const unknown = await fetch(`${env.stub.origin}/v1/everglades/graphql`, { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown_app", apps: [...APP_IDS] });
  });
});
