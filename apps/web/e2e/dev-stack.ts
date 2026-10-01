/**
 * The development stack for the team e2e scripts (team, notes): `wrangler dev --local` for the signal Worker,
 * a real Axum (`cargo run --release`) over a temp INVERSA_DATA_DIR with INVERSA_SOURCES=off, and `next dev`
 * proxying /v1 to it. `window.__team` (client/hud/missions/team.ts) exists in dev and e2e builds; e2e:team
 * defaults to the production e2e build on e2e/stack.ts and takes this stack with E2E_TEAM_STACK=dev. Free ports
 * throughout, so a developer's own `bun run dev` (3050, 4041, 8799) keeps running, but `next dev` here still
 * needs apps/web's dev lock, which a running `bun run dev` holds.
 *
 * Apps (PLAN.md C-A2, C-A6): `page` opens the stack's app (`?app=`, python by default), `graphql` posts to that
 * app's `/v1/<app>/graphql`, and its team board is `<app>:main` (`boardId`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "playwright";

import { boardIdFor, type AppId } from "../shared/apps";

export const APP_DIR = join(import.meta.dir, "..");
export const REPO_DIR = join(APP_DIR, "../..");
const SIGNAL_DIR = join(REPO_DIR, "apps/signal-worker");
const WRANGLER = "wrangler@4.145.0";
const READY_TIMEOUT_MS = 240_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fail(msg: string): never {
  throw new Error(msg);
}

/** A port the OS says is free, other than `not`. */
export function freePort(not?: number): number {
  for (;;) {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    if (port !== not) return port;
  }
}

export async function portBusy(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch (err) {
    return err instanceof Error && err.name === "TimeoutError";
  }
}

// ---- processes --------------------------------------------------------------------------------------

export type Proc = { name: string; child: ChildProcess; logPath: string; stop(): Promise<void> };

function start(scratch: string, name: string, cmd: string, args: string[], cwd: string, env: Record<string, string | undefined>): Proc {
  const logPath = join(scratch, `${name}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...env } });
  let exited = false;
  const exitedPromise = new Promise<void>((resolve) => child.once("exit", () => ((exited = true), resolve())));
  return {
    name,
    child,
    logPath,
    async stop() {
      if (exited || child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const killer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 5_000);
      await exitedPromise;
      clearTimeout(killer);
    },
  };
}

export const tail = (p: Proc, n = 40) => {
  try {
    return readFileSync(p.logPath, "utf8").split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
};

export async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs: number, dead?: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (dead?.()) fail(`${what}: process exited`);
    if (await probe()) return;
    await sleep(300);
  }
  fail(`${what}: not ready after ${timeoutMs / 1000}s`);
}

const ok = async (url: string, init?: RequestInit) => {
  try {
    return (await fetch(url, { ...init, signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};

export type DevStack = {
  signalUrl: string;
  apiPort: number;
  nextPort: number;
  /** The stack's app. */
  app: AppId;
  /** Its team board and RTC room, `<app>:main`. */
  boardId: string;
  /** The ops page, opened in the stack's app. */
  page: string;
  procs: Proc[];
  /** POST a GraphQL query to Axum. */
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  stop(): Promise<void>;
};

/** Start all three; `stop` kills them and removes the scratch dir. Throws (after stopping) when a port is busy. */
export async function startDevStack(name: string, app: AppId = "python"): Promise<DevStack> {
  const log = (...args: unknown[]) => console.error(`[e2e:${name}]`, ...args);
  const signalPort = freePort();
  const nextPort = freePort(signalPort);
  const signalUrl = `http://127.0.0.1:${signalPort}`;
  const page = `http://127.0.0.1:${nextPort}/?app=${app}`;
  for (const port of [signalPort, nextPort]) if (await portBusy(port)) fail(`port ${port} is already in use; stop that process first`);
  const scratch = mkdtempSync(join(tmpdir(), `${name}-e2e-`));
  const procs: Proc[] = [];
  const stop = async () => {
    await Promise.all(procs.map((p) => p.stop()));
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    log("starting wrangler dev, axum and next dev");
    const signal = start(
      scratch,
      "signal",
      "bunx",
      [WRANGLER, "dev", "--local", "--env", "dev", "--port", String(signalPort), "--ip", "127.0.0.1", "--persist-to", join(scratch, "wrangler-state"), "--var", `ALLOWED_ORIGIN:http://127.0.0.1:${nextPort}`],
      SIGNAL_DIR,
      { WRANGLER_SEND_METRICS: "false" },
    );
    procs.push(signal);
    const apiPort = freePort();
    const api = start(scratch, "api", "cargo", ["run", "-q", "--release", "--manifest-path", join(REPO_DIR, "api/Cargo.toml")], REPO_DIR, {
      INVERSA_DATA_DIR: join(scratch, "data"),
      INVERSA_SOURCES: "off",
      INVERSA_BIND: `127.0.0.1:${apiPort}`,
      RUST_LOG: "info",
    });
    procs.push(api);
    await Promise.all([
      waitFor("wrangler dev", () => ok(`${signalUrl}/turn`, { headers: { Origin: `http://127.0.0.1:${nextPort}` } }), READY_TIMEOUT_MS, () => signal.child.exitCode !== null),
      waitFor("axum", () => ok(`http://127.0.0.1:${apiPort}/health`), READY_TIMEOUT_MS, () => api.child.exitCode !== null),
    ]);

    // What `predev` does; then bind next to 127.0.0.1 itself, or Next 16 blocks its own dev chunks as cross-origin.
    for (const script of ["cesium:copy", "sqlite:copy"]) {
      const res = Bun.spawnSync(["bun", "run", script], { cwd: APP_DIR, stdout: "pipe", stderr: "pipe" });
      if (res.exitCode !== 0) fail(`${script}: ${res.stderr.toString()}`);
    }
    const next = start(scratch, "next", "bun", ["x", "next", "dev", "-p", String(nextPort), "-H", "127.0.0.1"], APP_DIR, {
      INVERSA_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      // An origin: the gql worker adds `/v1/<app>/graphql` for the app it serves.
      NEXT_PUBLIC_INVERSA_WS_URL: `ws://127.0.0.1:${apiPort}`,
      NEXT_PUBLIC_SIGNAL_URL: signalUrl,
      NEXT_TELEMETRY_DISABLED: "1",
      BROWSER: "none",
    });
    procs.push(next);
    await waitFor(
      "next dev",
      async () => {
        try {
          const res = await fetch(page, { signal: AbortSignal.timeout(20_000) });
          return res.ok && (await res.text()).includes("data-shell");
        } catch {
          return false;
        }
      },
      READY_TIMEOUT_MS,
      () => next.child.exitCode !== null,
    );
    log(`signal ${signalUrl}, api :${apiPort}, next ${page}`);
    return {
      app,
      boardId: boardIdFor(app),
      signalUrl,
      apiPort,
      nextPort,
      page,
      procs,
      async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
        const res = await fetch(`http://127.0.0.1:${apiPort}/v1/${app}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
        const json = (await res.json()) as { data?: T; errors?: unknown };
        if (!json.data) fail(`graphql: ${JSON.stringify(json.errors)}`);
        return json.data;
      },
      stop,
    };
  } catch (err) {
    for (const p of procs) console.log(`---- ${p.name} log ----\n${tail(p)}`);
    await stop();
    throw err;
  }
}

// ---- page helpers -----------------------------------------------------------------------------------

/** Resolve with the observer's Date.now() once `text` appears inside `selector`. Started before the edit. */
export function watchFor(page: Page, selector: string, text: string, timeoutMs = 30_000): Promise<number> {
  return page.evaluate(
    ({ selector, text, timeoutMs }) =>
      new Promise<number>((resolve, reject) => {
        const root = document.querySelector(selector);
        if (!root) {
          reject(new Error(`no ${selector}`));
          return;
        }
        const hit = () => (root.textContent ?? "").includes(text);
        if (hit()) {
          resolve(Date.now());
          return;
        }
        const timer = setTimeout(() => {
          mo.disconnect();
          reject(new Error(`timed out waiting for ${JSON.stringify(text)}`));
        }, timeoutMs);
        const mo = new MutationObserver(() => {
          if (!hit()) return;
          clearTimeout(timer);
          mo.disconnect();
          resolve(Date.now());
        });
        mo.observe(root, { subtree: true, childList: true, characterData: true });
      }),
    { selector, text, timeoutMs },
  );
}

/** Resolve once `selector` disappears from the DOM, or fail after `timeoutMs`. */
export function watchGone(page: Page, selector: string, timeoutMs = 30_000): Promise<number> {
  return page.evaluate(
    ({ selector, timeoutMs }) =>
      new Promise<number>((resolve, reject) => {
        if (!document.querySelector(selector)) {
          resolve(Date.now());
          return;
        }
        const timer = setTimeout(() => {
          mo.disconnect();
          reject(new Error(`timed out waiting for ${selector} to go`));
        }, timeoutMs);
        const mo = new MutationObserver(() => {
          if (document.querySelector(selector)) return;
          clearTimeout(timer);
          mo.disconnect();
          resolve(Date.now());
        });
        mo.observe(document.body, { subtree: true, childList: true, attributes: true });
      }),
    { selector, timeoutMs },
  );
}

/** Open the ops page on the Notes tab (the board) and wait for the team session; `errs` collects page errors. */
export async function openBoard(page: Page, url: string, errs: string[], onConsole?: (text: string) => void): Promise<void> {
  page.on("pageerror", (err) => errs.push(err.message));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
    onConsole?.(m.text());
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // The board lives in the chat column's Notes tab (T40, T43); the session starts with the page either way.
  await page.click('[data-tab="board"]', { timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.__team) && document.querySelector('[data-testid="team-panel"][data-ready="1"]') !== null, null, { timeout: 120_000 });
}

/** Unfold "Crew missions" (T43: missions sit behind a disclosure inside the Notes tab). */
export async function openCrewMissions(page: Page): Promise<void> {
  const details = page.locator('[data-testid="crew-missions"]');
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator("summary").click();
  await page.waitForSelector('[data-testid="crew-missions"][open]', { state: "attached" });
  // The mission list is an empty (zero-height) <ul> until a mission exists; the form or its hint is always shown.
  await page.locator('[data-testid="mission-form"], [data-testid="mission-hint"]').first().waitFor();
}
