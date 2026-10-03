import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GET, POST } from "@/app/api/dev/keys/route";
import { handleGet, handlePost, isLoopbackRequest, localKeysPath, type DevEnv } from "@/server/dev-keys";
import type { ServerKeyStatus } from "shared/keys";

const SENTINEL = "SENTINEL-DO-NOT-LEAK";
const ORIGIN = "http://127.0.0.1:3050";
const scratch = mkdtempSync(path.join(tmpdir(), "dev-keys-test-"));
let dataDir = "";
let n = 0;

/** Everything written to the console while a test runs. */
let logged: string[] = [];
const methods = ["log", "info", "warn", "error", "debug"] as const;
const originals = Object.fromEntries(methods.map((m) => [m, console[m]]));

beforeEach(() => {
  dataDir = path.join(scratch, `data-${n++}`);
  logged = [];
  for (const m of methods) console[m] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
});
afterEach(() => {
  for (const m of methods) console[m] = originals[m]!;
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function req(method: "GET" | "POST", body?: unknown, headers: Record<string, string | null> = {}): Request {
  const h: Record<string, string> = {};
  const merged: Record<string, string | null> = { host: "127.0.0.1:3050", origin: ORIGIN, "sec-fetch-site": "same-origin", "x-forwarded-for": "127.0.0.1", "content-type": "application/json", ...headers };
  for (const [k, v] of Object.entries(merged)) if (v !== null) h[k] = v;
  return new Request(`${ORIGIN}/api/dev/keys`, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}

const devEnv = (extra: DevEnv = {}): DevEnv => ({ NODE_ENV: "development", INVERSA_DATA_DIR: dataDir, ...extra });

async function read(res: Response): Promise<{ status: number; text: string; json: unknown }> {
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

describe("dev keys route", () => {
  test("GET reports booleans and sources only: an external key is set, its value never in the body", async () => {
    const env = devEnv({ OPENROUTER_API_KEY: SENTINEL, GOES_SQS_URL: SENTINEL });
    const res = await read(handleGet(req("GET"), env));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SENTINEL);
    const rows = res.json as ServerKeyStatus[];
    expect(rows.map((r) => r.id)).toEqual(["aisstream", "openrouter", "xai", "fastino", "aws-goes", "nwws"]);
    expect(rows.find((r) => r.id === "openrouter")).toEqual({ id: "openrouter", set: true, source: "external", writable: true, vars: [{ name: "OPENROUTER_API_KEY", set: true, source: "external" }] });
    // A row needing three variables is set only when all three are.
    expect(rows.find((r) => r.id === "aws-goes")).toMatchObject({ set: false, source: null, vars: [{ set: true, source: "external" }, { set: false }, { set: false }] });
    for (const r of rows) for (const v of r.vars) expect(typeof v.set).toBe("boolean");
    expect(logged.join("\n")).not.toContain(SENTINEL);
  });

  test("POST writes data/local-keys.env with mode 0600, echoes names only, and GET then shows it pending, then local", async () => {
    const env = devEnv({ INVERSA_DEV_SUPERVISOR: "1" });
    const res = await read(await handlePost(req("POST", { values: { AISSTREAM_API_KEY: SENTINEL, NWWS_USER: "user-1" } }), env));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SENTINEL);
    expect(res.json).toMatchObject({ saved: ["AISSTREAM_API_KEY", "NWWS_USER"], external: [], restart: "supervisor" });
    const file = localKeysPath(env);
    expect(file).toBe(path.join(dataDir, "local-keys.env"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(`AISSTREAM_API_KEY=${SENTINEL}\n`);

    const pending = await read(handleGet(req("GET"), env));
    expect(pending.text).not.toContain(SENTINEL);
    expect((pending.json as ServerKeyStatus[]).find((r) => r.id === "aisstream")).toMatchObject({ set: false, source: "pending" });
    // NWWS needs two variables: one pending, one missing.
    expect((pending.json as ServerKeyStatus[]).find((r) => r.id === "nwws")).toMatchObject({ set: false, source: "pending", vars: [{ source: "pending" }, { source: null }] });

    // After the supervisor restart: the value is in the env and its name in INVERSA_LOCAL_KEYS.
    const loaded = await read(handleGet(req("GET"), { ...env, AISSTREAM_API_KEY: SENTINEL, INVERSA_LOCAL_KEYS: "AISSTREAM_API_KEY" }));
    expect(loaded.text).not.toContain(SENTINEL);
    expect((loaded.json as ServerKeyStatus[]).find((r) => r.id === "aisstream")).toMatchObject({ set: true, source: "local" });

    // A second save keeps the other values and the mode; without the supervisor the answer says restart by hand.
    const second = await read(await handlePost(req("POST", { values: { XAI_API_KEY: "xai-dummy-1" } }), devEnv()));
    expect(second.json).toMatchObject({ saved: ["XAI_API_KEY"], restart: "manual" });
    const text = readFileSync(file, "utf8");
    expect(text).toContain(`AISSTREAM_API_KEY=${SENTINEL}`);
    expect(text).toContain("NWWS_USER=user-1");
    expect(text).toContain("XAI_API_KEY=xai-dummy-1");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const logs = logged.join("\n");
    expect(logs).not.toContain(SENTINEL);
    expect(logs).not.toContain("user-1");
    expect(logs).toContain("[dev keys] saved AISSTREAM_API_KEY, NWWS_USER");
  });

  test("a key already in the environment is reported external and not overwritten", async () => {
    const env = devEnv({ OPENROUTER_API_KEY: "from-doppler" });
    const res = await read(await handlePost(req("POST", { values: { OPENROUTER_API_KEY: SENTINEL } }), env));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SENTINEL);
    expect(res.json).toMatchObject({ saved: [], external: ["OPENROUTER_API_KEY"] });
    expect(existsSync(localKeysPath(env))).toBe(false);
    // A name the supervisor loaded from the file is local, so it can be replaced.
    const local = await read(await handlePost(req("POST", { values: { OPENROUTER_API_KEY: "replacement" } }), { ...env, INVERSA_LOCAL_KEYS: "OPENROUTER_API_KEY" }));
    expect(local.json).toMatchObject({ saved: ["OPENROUTER_API_KEY"], external: [] });
    expect(logged.join("\n")).not.toContain(SENTINEL);
  });

  test("403 outside development or off loopback; nothing written, the sentinel never echoed", async () => {
    const body = { values: { AISSTREAM_API_KEY: SENTINEL } };
    const cases: [string, Request, DevEnv][] = [
      ["production", req("POST", body), devEnv({ NODE_ENV: "production" })],
      ["production with dev routes on", req("POST", body), devEnv({ NODE_ENV: "production", INVERSA_DEV_ROUTES: "1" })],
      ["test env", req("POST", body), devEnv({ NODE_ENV: "test" })],
      ["foreign host (DNS rebinding)", req("POST", body, { host: "evil.example:3050", origin: "http://evil.example:3050" }), devEnv()],
      ["LAN peer", req("POST", body, { "x-forwarded-for": "192.168.1.20" }), devEnv()],
      ["proxied LAN peer", req("POST", body, { "x-forwarded-for": "127.0.0.1, 10.0.0.7" }), devEnv()],
      ["cross-site page", req("POST", body, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }), devEnv()],
      ["cross-site, no origin", req("POST", body, { origin: null, "sec-fetch-site": "cross-site" }), devEnv()],
      ["other loopback port", req("POST", body, { origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" }), devEnv()],
      ["no host", req("POST", body, { host: null }), devEnv()],
    ];
    for (const [name, request, env] of cases) {
      const res = await read(await handlePost(request, env));
      expect([name, res.status]).toEqual([name, 403]);
      expect(res.text).not.toContain(SENTINEL);
      expect(res.text).toContain("doppler secrets set");
      expect([name, existsSync(localKeysPath(env))]).toEqual([name, false]);
      // GET still answers (booleans only) but says the panel cannot write here.
      const get = await read(handleGet(request, { ...env, AISSTREAM_API_KEY: SENTINEL }));
      expect(get.text).not.toContain(SENTINEL);
      expect((get.json as ServerKeyStatus[]).every((r) => !r.writable)).toBe(true);
    }
    // localhost, [::1] and a client without browser headers (curl on the same machine) are loopback.
    expect(isLoopbackRequest(req("POST", body, { host: "localhost:3050", origin: "http://localhost:3050" }))).toBe(true);
    expect(isLoopbackRequest(req("POST", body, { host: "[::1]:3050", origin: "http://[::1]:3050", "x-forwarded-for": "::1" }))).toBe(true);
    expect(isLoopbackRequest(req("POST", body, { origin: null, "sec-fetch-site": null, "x-forwarded-for": "::ffff:127.0.0.1" }))).toBe(true);
    expect(logged.join("\n")).not.toContain(SENTINEL);
  });

  test("bad requests: wrong content type, not JSON, unknown names, unsafe values", async () => {
    const env = devEnv();
    const statuses: [string, number][] = [];
    const post = async (name: string, request: Request) => {
      const res = await read(await handlePost(request, env));
      expect(res.text).not.toContain(SENTINEL);
      statuses.push([name, res.status]);
    };
    await post("form post", req("POST", `values=${SENTINEL}`, { "content-type": "application/x-www-form-urlencoded" }));
    await post("text post", req("POST", JSON.stringify({ values: { AISSTREAM_API_KEY: SENTINEL } }), { "content-type": "text/plain" }));
    await post("not json", req("POST", `{${SENTINEL}`));
    await post("no values", req("POST", { values: {} }));
    await post("array", req("POST", { values: [SENTINEL] }));
    await post("unknown name", req("POST", { values: { PATH: SENTINEL } }));
    await post("browser key", req("POST", { values: { NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: SENTINEL } }));
    await post("newline injection", req("POST", { values: { AISSTREAM_API_KEY: `${SENTINEL}\nOPENROUTER_API_KEY=x` } }));
    await post("space", req("POST", { values: { AISSTREAM_API_KEY: `${SENTINEL} x` } }));
    await post("too big", req("POST", "x".repeat(70_000)));
    expect(statuses).toEqual([
      ["form post", 415],
      ["text post", 415],
      ["not json", 400],
      ["no values", 400],
      ["array", 400],
      ["unknown name", 400],
      ["browser key", 400],
      ["newline injection", 400],
      ["space", 400],
      ["too big", 413],
    ]);
    expect(existsSync(localKeysPath(env))).toBe(false);
    expect(logged.join("\n")).not.toContain(SENTINEL);
  });

  test("the route module reads process.env: GET has no value, POST under bun test (NODE_ENV test) is 403", async () => {
    const saved = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, INVERSA_DATA_DIR: process.env.INVERSA_DATA_DIR };
    process.env.OPENROUTER_API_KEY = SENTINEL;
    process.env.INVERSA_DATA_DIR = dataDir;
    try {
      const get = await read(GET(req("GET")));
      expect(get.status).toBe(200);
      expect(get.text).not.toContain(SENTINEL);
      expect((get.json as ServerKeyStatus[]).find((r) => r.id === "openrouter")).toMatchObject({ set: true, source: "external" });
      const post = await read(await POST(req("POST", { values: { AISSTREAM_API_KEY: SENTINEL } })));
      expect(post.status).toBe(403);
      expect(post.text).not.toContain(SENTINEL);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(logged.join("\n")).not.toContain(SENTINEL);
  });

  test("a stale temp file never replaces the target and a pre-existing file keeps 0600", async () => {
    const env = devEnv();
    const file = localKeysPath(env);
    await handlePost(req("POST", { values: { XAI_API_KEY: "first" } }), env);
    writeFileSync(file, readFileSync(file, "utf8"), { mode: 0o600 });
    await handlePost(req("POST", { values: { NWWS_PASS: "second" } }), env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toMatch(/NWWS_PASS=second\nXAI_API_KEY=first\n$/);
  });
});
