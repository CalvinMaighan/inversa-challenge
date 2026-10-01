import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GET } from "@/app/api/health/route";
import { resetBudgetCache } from "@/server/agent/budget";
import { clearHealthCache, computeHealth, type WebHealth } from "@/server/health";

/**
 * `GET /api/health` (gates/leaf-H1.md G2) against a fake Axum `/health` and a fake signal Worker: a missing
 * credential is `down` with its reason, an app whose database failed makes the whole status `down` (503), a dead
 * API is `down` with a reason, and optional dependencies only degrade.
 */

const saved = { ...process.env };
const dataDir = mkdtempSync(path.join(tmpdir(), "inversa-health-"));
let apiBody: unknown;
let apiStatus = 200;
const api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(apiBody, { status: apiStatus }) });
let signalStatus = 200;
const signal = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/rooms/health-probe/peers" ? new Response("[]", { status: signalStatus }) : new Response("no", { status: 404 })) });

const feed = (source: string, state: string, note: string | null = null) => ({ source, mode: "poll", state, newestObservedAt: null, lastFetchAt: null, lastFetchRunId: null, lagSeconds: null, note });
const app = (id: string, feeds: unknown) => ({ id, name: id, kind: "species", provisional: false, regions: [], taxa: [], feeds });

beforeEach(() => {
  clearHealthCache();
  resetBudgetCache();
  process.env.INVERSA_DATA_DIR = dataDir;
  process.env.INVERSA_API_ORIGIN = `http://127.0.0.1:${api.port}`;
  process.env.SIGNAL_WORKER_URL = `http://127.0.0.1:${signal.port}/`;
  process.env.OPENROUTER_API_KEY = "sk-test-never-sent";
  process.env.XAI_API_KEY = "xai-test-never-sent";
  apiStatus = 200;
  signalStatus = 200;
  apiBody = { status: "ok", defaultApp: "carp", apps: ["carp", "lionfish", "python"].map((id) => app(id, [feed("usgs", "nominal")])) };
});

afterAll(() => {
  process.env = saved;
  api.stop(true);
  signal.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("web health", () => {
  test("everything up: ok, 200, one entry per app", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as WebHealth;
    expect(body.status).toBe("ok");
    expect(body.api.state).toBe("up");
    expect(body.apps.map((a) => [a.id, a.db])).toEqual([["carp", "ok"], ["lionfish", "ok"], ["python", "ok"]]);
    expect(body.signal).toEqual({ state: "up" });
    expect(body.agent).toMatchObject({ state: "up", capUsd: 5 });
  });

  test("a missing credential is a down feed with its reason; missing keys and Worker degrade, never 503", async () => {
    apiBody = { status: "ok", defaultApp: "carp", apps: [app("carp", [feed("nwws", "down", "NWWS_USER and NWWS_PASS are not set")]), app("lionfish", []), app("python", [])] };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.SIGNAL_WORKER_URL;
    const h = await computeHealth();
    expect(h.status).toBe("degraded");
    expect(h.apps[0]!.downFeeds).toEqual([{ source: "nwws", reason: "NWWS_USER and NWWS_PASS are not set" }]);
    expect(h.agent.reason).toBe("agent unavailable: OPENROUTER_API_KEY not set");
    expect(h.voice.reason).toContain("XAI_API_KEY");
    expect(h.signal.reason).toContain("SIGNAL_WORKER_URL is not set");
    signalStatus = 500;
    process.env.SIGNAL_WORKER_URL = `http://127.0.0.1:${signal.port}`;
    expect((await computeHealth()).signal).toEqual({ state: "down", reason: "signal Worker answered 500" });
  });

  test("one app's database failing is down (503) with Axum's error, the other apps stay ok", async () => {
    apiStatus = 503;
    apiBody = { status: "degraded", defaultApp: "carp", apps: [app("carp", []), app("lionfish", { error: "lionfish/observations.db is missing on disk" }), app("python", [])] };
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as WebHealth;
    expect(body.status).toBe("down");
    expect(body.api.state).toBe("up");
    expect(body.apps.map((a) => a.db)).toEqual(["ok", "down", "ok"]);
    expect(body.apps[1]!.reason).toBe("lionfish/observations.db is missing on disk");
  });

  test("a dead API is down with a reason, and the probe gives up within its timeout", async () => {
    process.env.INVERSA_API_ORIGIN = "http://127.0.0.1:9";
    const h = await computeHealth();
    expect(h.status).toBe("down");
    expect(h.api.state).toBe("down");
    expect(h.api.reason).toStartWith("API unreachable: ");
    expect(h.apps.every((a) => a.db === "down" && a.reason === "API unreachable")).toBe(true);
  });
});
