/**
 * `bun run dev`: Axum API, Next web and the signal Worker together, prefixed output, one Ctrl-C stops all three.
 * Data lives in ./data (fill it with `bun run data`, which needs no secrets).
 *
 * Secrets come from Doppler project `inversa`, config `dev` (OPENROUTER_API_KEY for the agent, and any other
 * keys set there), downloaded straight into the children's env and never printed. When doppler is missing or
 * not logged in, the children get the plain env with a warning; without OPENROUTER_API_KEY the agent route
 * answers 503 "agent unavailable: OPENROUTER_API_KEY not set".
 *
 * Local keys (docs/GODS_EYE.md, Developer panel): `<data dir>/local-keys.env` (written by the panel through
 * `POST /api/dev/keys`, mode 0600, git-ignored) is loaded under the shell and Doppler: a variable set in either
 * wins over the file. The file is watched; when it changes, the API and web processes this script started are
 * restarted with the new values (each child runs in its own process group, so a restart stops exactly that
 * child and what it spawned). Values are never printed, only names.
 *
 * Ports: INVERSA_WEB_PORT (3050), INVERSA_API_PORT (4041) and INVERSA_SIGNAL_PORT (8799) move the three, so a
 * second stack (e2e/developer.ts) runs beside a developer's own.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";

import type { Subprocess } from "bun";

import { parseEnvFile } from "../apps/web/shared/keys";

const root = new URL("..", import.meta.url).pathname;
const WEB_PORT = process.env.INVERSA_WEB_PORT ?? "3050";
const API_PORT = process.env.INVERSA_API_PORT ?? "4041";
const SIGNAL_PORT = process.env.INVERSA_SIGNAL_PORT ?? "8799";
const DATA_DIR = process.env.INVERSA_DATA_DIR ?? `${root}data`;
const LOCAL_KEYS = join(DATA_DIR, "local-keys.env");

/** Doppler `inversa`/`dev` secrets, or null with the reason it could not load them. */
function dopplerSecrets(): { secrets: Record<string, string> } | { error: string } {
  let result;
  try {
    result = Bun.spawnSync(
      ["doppler", "secrets", "download", "--no-file", "--format", "json", "--project", "inversa", "--config", "dev"],
      { stdout: "pipe", stderr: "pipe" },
    );
  } catch {
    return { error: "doppler CLI not found" };
  }
  if (result.exitCode !== 0) {
    // stderr carries doppler's reason (not logged in, no access); it never contains secret values.
    const reason = result.stderr.toString().trim().split("\n").at(-1) || `exit ${result.exitCode}`;
    return { error: reason };
  }
  try {
    const parsed = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
    return {
      secrets: Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    };
  } catch {
    return { error: "doppler returned output that is not JSON" };
  }
}

// INVERSA_DOPPLER=off: the plain environment only (e2e/developer.ts runs a stack without your secrets).
const doppler = process.env.INVERSA_DOPPLER === "off" ? { error: "INVERSA_DOPPLER=off" } : dopplerSecrets();
// Without Doppler (not installed, not logged in, offline) the root `.env` that `bun run env` wrote stands in for it.
let dotEnv: Record<string, string> = {};
try {
  dotEnv = parseEnvFile(readFileSync(join(root, ".env"), "utf8"));
} catch {
  // No .env: the plain environment.
}
if ("error" in doppler) {
  const names = Object.keys(dotEnv).length;
  console.warn(
    names > 0
      ? `\x1b[33mwarning:\x1b[0m Doppler inversa/dev not loaded (${doppler.error}); using ${names} keys from .env (run bun run env to refresh it).`
      : `\x1b[33mwarning:\x1b[0m Doppler inversa/dev not loaded (${doppler.error}); using the plain environment.`,
  );
}
const dopplerEnv = "secrets" in doppler ? doppler.secrets : dotEnv;

/**
 * Dev-only hook secret (PLAN.md C18): with it the signed ingest hook is on, so a raw provider body can be
 * delivered with `POST /v1/{app}/ingest/hook/{source}` for any poll source the app runs (C10) to watch live updates end to end. A fresh random value per start,
 * printed once below; an `INGEST_HOOK_SECRET` from the shell or Doppler wins and is not printed.
 */
const configuredHookSecret = process.env.INGEST_HOOK_SECRET || dopplerEnv.INGEST_HOOK_SECRET;
const generatedHookSecret = configuredHookSecret ? null : randomBytes(24).toString("hex");

/** The local keys file, or {} when it is missing or unreadable. Warns (names only) when others can read it. */
function readLocalKeys(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(LOCAL_KEYS, "utf8");
  } catch {
    return {};
  }
  try {
    if (statSync(LOCAL_KEYS).mode & 0o077) console.warn(`\x1b[33mwarning:\x1b[0m ${LOCAL_KEYS} is readable by other users; run chmod 600 on it.`);
  } catch {
    // Gone between the read and the stat: the read already has it.
  }
  return parseEnvFile(text);
}

/** The children's env: local file, then Doppler, then the shell (each later one wins). */
function childEnv(local: Record<string, string>): Record<string, string | undefined> {
  // Names (never values) the file supplies, so `GET /api/dev/keys` can tell "local" from "external".
  const fromFile = Object.keys(local).filter((name) => !process.env[name]?.trim() && !dopplerEnv[name]?.trim());
  return {
    ...local,
    ...dopplerEnv,
    ...process.env,
    INGEST_HOOK_SECRET: configuredHookSecret || generatedHookSecret!,
    INVERSA_DATA_DIR: DATA_DIR,
    INVERSA_BIND: process.env.INVERSA_BIND ?? `127.0.0.1:${API_PORT}`,
    INVERSA_API_ORIGIN: process.env.INVERSA_API_ORIGIN ?? `http://127.0.0.1:${API_PORT}`,
    NEXT_PUBLIC_INVERSA_WS_URL: process.env.NEXT_PUBLIC_INVERSA_WS_URL ?? `ws://127.0.0.1:${API_PORT}/v1/graphql`,
    INVERSA_LOCAL_KEYS: fromFile.join(","),
    INVERSA_DEV_SUPERVISOR: "1",
  };
}

let localKeys = readLocalKeys();
let env = childEnv(localKeys);

const keySource = !env.OPENROUTER_API_KEY?.trim()
  ? null
  : process.env.OPENROUTER_API_KEY?.trim()
    ? "shell env"
    : dopplerEnv.OPENROUTER_API_KEY?.trim()
      ? "doppler inversa/dev"
      : "data/local-keys.env";

type Child = { name: string; proc: Subprocess; restarting: boolean };
const procs = new Map<string, Child>();

/** Signal a child's whole process group (cargo and the API it runs, bun and the next server it runs). */
function signalGroup(child: Child, sig: NodeJS.Signals) {
  try {
    process.kill(-child.proc.pid, sig);
  } catch {
    // Already gone.
  }
}

/** `optional`: the process may exit (e.g. no network for bunx) without taking the others down. */
function start(name: string, color: string, cmd: string[], cwd: string, optional = false) {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe", detached: true });
  const child: Child = { name, proc, restarting: false };
  procs.set(name, child);
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of stream as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) process.stdout.write(prefix + line + "\n");
      }
      if (buf) process.stdout.write(prefix + buf + "\n");
    })();
  }
  void proc.exited.then((code) => {
    // Stopped by a signal (`bun run api:kill`, a manual kill): deliberate, not a crash, so the others keep running.
    // The supervisor itself ends once every child is gone.
    const signalled = proc.signalCode != null || code === 143 || code === 137 || code === 130;
    process.stdout.write(`${prefix}${signalled ? `stopped (${proc.signalCode ?? `exit ${code}`})` : `exited with ${code}`}\n`);
    if (child.restarting) return;
    if (!signalled) {
      if (!optional) shutdown(code ?? 1);
    } else if (procs.get(name) === child && [...procs.values()].every((c) => c.proc.exitCode !== null || c.proc.signalCode !== null)) {
      shutdown(0);
    }
  });
}

/** Stop one child (its group: SIGTERM, then SIGKILL after 5 s) and wait for it. */
async function stopChild(child: Child) {
  child.restarting = true;
  signalGroup(child, "SIGTERM");
  const killer = setTimeout(() => signalGroup(child, "SIGKILL"), 5_000);
  await child.proc.exited;
  clearTimeout(killer);
}

let stopping = false;
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  unwatchFile(LOCAL_KEYS);
  for (const child of procs.values()) signalGroup(child, "SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
// The children are in their own groups, so a terminal's Ctrl-C no longer reaches them directly: never leave one behind.
process.on("exit", () => {
  for (const child of procs.values()) signalGroup(child, "SIGTERM");
});

const startApi = () => start("api", "36", ["cargo", "run", "-q", "--release", "--manifest-path", "api/Cargo.toml"], root);
const webArgs = [...(WEB_PORT === "3050" ? [] : ["-p", WEB_PORT]), ...(process.env.INVERSA_WEB_HOST ? ["-H", process.env.INVERSA_WEB_HOST] : [])];

// Web waits for the API: `cargo run` may compile for minutes, and a page already open in the browser would
// hammer the /v1 proxy with ECONNREFUSED stack traces (and GraphQL 500s in the console) until the API listens.
async function startWebWhenApiUp() {
  const started = Date.now();
  let announced = false;
  while (!stopping) {
    try {
      if ((await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (!announced && Date.now() - started > 5_000) {
      announced = true;
      console.log("\x1b[36m[api]\x1b[0m building or starting; web starts when /health answers");
    }
    await Bun.sleep(500);
  }
  // `bun run dev` is `next dev -p 3050`; a later `-p` wins (Next's CLI keeps the last value).
  if (!stopping) start("web", "35", ["bun", "run", "dev", ...webArgs], `${root}apps/web`);
}

/** One web start at a time: a keys restart while the first build still waits for the API joins that wait. */
let webWaiter: Promise<void> | null = null;
function ensureWeb(): Promise<void> {
  webWaiter ??= startWebWhenApiUp().finally(() => {
    webWaiter = null;
  });
  return webWaiter;
}

/** The local keys file changed with different names or values: restart the API and web with the new env. */
let restarting: Promise<void> | null = null;
let restartAgain = false;
async function restartForKeys() {
  if (stopping) return;
  if (restarting) {
    restartAgain = true;
    return;
  }
  restarting = (async () => {
    do {
      restartAgain = false;
      const next = readLocalKeys();
      if (JSON.stringify(next) === JSON.stringify(localKeys)) continue;
      const changed = [...new Set([...Object.keys(next), ...Object.keys(localKeys)])].filter((n) => next[n] !== localKeys[n]).sort();
      localKeys = next;
      env = childEnv(localKeys);
      console.log(`\x1b[32m[dev]\x1b[0m local-keys.env changed (${changed.join(", ")}): restarting api and web`);
      const running = ["web", "api"].map((n) => procs.get(n)).filter((c): c is Child => Boolean(c));
      await Promise.all(running.map(stopChild));
      if (stopping) return;
      startApi();
      // A first start still waiting for the API is joined, not doubled; it reads the new env when it spawns.
      await ensureWeb();
      console.log("\x1b[32m[dev]\x1b[0m restarted api and web with the new keys");
    } while (restartAgain && !stopping);
  })().finally(() => {
    restarting = null;
  });
}

// Polling (1 s) works for a file that does not exist yet and survives the panel's write-then-rename.
watchFile(LOCAL_KEYS, { interval: 1_000 }, (cur, prev) => {
  if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size || cur.ino !== prev.ino) void restartForKeys();
});

const agent = keySource
  ? `openrouter openai/gpt-6-luna (key from ${keySource})`
  : "unavailable, OPENROUTER_API_KEY not set (/api/agent/stream answers 503)";
const localNote = Object.keys(localKeys).length ? ` · local keys: ${Object.keys(localKeys).sort().join(", ")}` : "";
console.log(`data: ${DATA_DIR} · agent: ${agent} · web: http://localhost:${WEB_PORT} · signal: http://127.0.0.1:${SIGNAL_PORT}${localNote}`);
if (generatedHookSecret) console.log(`ingest hook (dev only): POST http://127.0.0.1:${API_PORT}/v1/<app>/ingest/hook/<source>, INGEST_HOOK_SECRET=${generatedHookSecret}`);
// An API already answering on the port (a separate `bun run api`) is reused, not fought over: no bind panic.
const apiRunning = await fetch(`http://127.0.0.1:${API_PORT}/health`).then((r) => r.ok, () => false);
if (apiRunning) console.log(`\x1b[36m[api]\x1b[0m already running on :${API_PORT}; using it`);
else startApi();
void ensureWeb();
// Same pinned wrangler as apps/signal-worker (package.json `dev`, scripts/e2e.ts); env dev allows origin localhost:3050.
start("signal", "33", ["bunx", "wrangler@4.145.0", "dev", "--local", "--port", SIGNAL_PORT, "--ip", "127.0.0.1", "--env", "dev", "--log-level", "warn"], `${root}apps/signal-worker`, true);
