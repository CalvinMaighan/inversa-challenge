/**
 * `bun run dev`: Axum API, Next web and the signal Worker together, prefixed output, one Ctrl-C stops all three.
 * Data lives in ./data (fill it with `bun run data`, which needs no secrets).
 *
 * Secrets come from Doppler project `inversa`, config `dev` (OPENROUTER_API_KEY for the agent, and any other
 * keys set there), downloaded straight into the children's env and never printed. When doppler is missing or
 * not logged in, the children get the plain env with a warning; without OPENROUTER_API_KEY the agent route
 * answers 503 "agent unavailable: OPENROUTER_API_KEY not set".
 */
import { randomBytes } from "node:crypto";

import type { Subprocess } from "bun";

const root = new URL("..", import.meta.url).pathname;

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

const doppler = dopplerSecrets();
if ("error" in doppler) {
  console.warn(`\x1b[33mwarning:\x1b[0m Doppler inversa/dev not loaded (${doppler.error}); using the plain environment.`);
}

/**
 * Dev-only hook secret (PLAN.md C18): with it the `web` hook source is on, so rows can be injected with a
 * signed `POST /v1/ingest/hook/web` (C10) to watch live updates end to end. A fresh random value per start,
 * printed once below; an `INGEST_HOOK_SECRET` from the shell or Doppler wins and is not printed.
 */
const configuredHookSecret = process.env.INGEST_HOOK_SECRET || ("secrets" in doppler ? doppler.secrets.INGEST_HOOK_SECRET : undefined);
const generatedHookSecret = configuredHookSecret ? null : randomBytes(24).toString("hex");

// Variables already set in the shell win over Doppler, so a one-off override needs no Doppler edit.
const env: Record<string, string | undefined> = {
  ...("secrets" in doppler ? doppler.secrets : {}),
  ...process.env,
  INGEST_HOOK_SECRET: configuredHookSecret || generatedHookSecret!,
  INVERSA_DATA_DIR: process.env.INVERSA_DATA_DIR ?? `${root}data`,
  NEXT_PUBLIC_INVERSA_WS_URL: process.env.NEXT_PUBLIC_INVERSA_WS_URL ?? "ws://127.0.0.1:4041/v1/graphql",
};

const keySource = !env.OPENROUTER_API_KEY?.trim()
  ? null
  : process.env.OPENROUTER_API_KEY?.trim()
    ? "shell env"
    : "doppler inversa/dev";

const procs: { name: string; color: string; proc: Subprocess }[] = [];

/** `optional`: the process may exit (e.g. no network for bunx) without taking the others down. */
function start(name: string, color: string, cmd: string[], cwd: string, optional = false) {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  procs.push({ name, color, proc });
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
    process.stdout.write(`${prefix}exited with ${code}\n`);
    if (!optional) shutdown(code ?? 1);
  });
}

let stopping = false;
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const { proc } of procs) proc.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const agent = keySource
  ? `openrouter openai/gpt-6-luna (key from ${keySource})`
  : "unavailable, OPENROUTER_API_KEY not set (/api/agent/stream answers 503)";
console.log(`data: ${env.INVERSA_DATA_DIR} · agent: ${agent} · web: http://localhost:3050 · signal: http://127.0.0.1:8799`);
if (generatedHookSecret) console.log(`ingest hook (dev only): POST http://127.0.0.1:4041/v1/ingest/hook/web, INGEST_HOOK_SECRET=${generatedHookSecret}`);
start("api", "36", ["cargo", "run", "-q", "--release", "--manifest-path", "api/Cargo.toml"], root);
start("web", "35", ["bun", "run", "dev"], `${root}apps/web`);
// Same pinned wrangler as apps/signal-worker (package.json `dev`, scripts/e2e.ts); env dev allows origin localhost:3050.
start("signal", "33", ["bunx", "wrangler@4.145.0", "dev", "--local", "--port", "8799", "--ip", "127.0.0.1", "--env", "dev"], `${root}apps/signal-worker`, true);
