/**
 * Live feeds (rubric `feeds-realtime/live-fetch`): one app's pollers against the real providers, on a fresh data
 * dir, for one poll window.
 *
 *   bun run e2e:feeds -- --app <id>     build the API, run it for <id> with sources on, print the FEEDS line
 *   FEEDS_WINDOW_S=<n>                  the window's upper bound (default 300 s)
 *
 * Axum runs alone (`INVERSA_APPS=<id>`, no fixtures, no `INVERSA_SOURCES=off`) over an empty temp data dir, so every
 * row it holds came from the network during this run. Each source the app lists starts its fetch loop at boot; the
 * window ends when every runnable source has a successful fetch run (`fetch_runs.status` ok, empty or partial) or
 * at the bound. The counts are read from the app's own `observations.db` (read-only) and cross-checked with the
 * GraphQL `feeds` answer:
 *
 *   fetched   sources with at least one successful fetch run in the window (each source counts once);
 *   failed    sources that could run (no missing credential) and have no successful fetch run: every run errored,
 *             or none happened by the bound;
 *   skipped   sources the API did not start because a credential is absent (`sources.disabled_reason`, e.g. NWWS
 *             login, GOES SQS keys); a push source that is configured but delivered nothing yet is `waiting`;
 *   records   rows the successful runs wrote (`fetch_runs.rows_in`).
 *
 * Line: `FEEDS app=<id> fetched=<n> failed=<n> skipped=<n> waiting=<n> records=<n>`. Exit 0 only when fetched >= 3,
 * failed = 0 and records >= 1. Needs the network.
 */
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getApp } from "../shared/apps";
import { appArg } from "./args";
import { API_BIN, REPO_DIR, buildApi, freePort } from "./stack";

const APP = appArg();
const WINDOW_MS = Number(process.env.FEEDS_WINDOW_S ?? 300) * 1000;
const OK = new Set(["ok", "empty", "partial"]);

const log = (...a: unknown[]) => console.error("[e2e:feeds]", ...a);

type SourceRow = { id: string; mode: string; disabled_reason: string | null };
type RunRow = { source_id: string; status: string; rows_in: number; http_status: number | null; error: string | null };

function read(dbPath: string): { sources: SourceRow[]; runs: RunRow[] } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      sources: db.query<SourceRow, []>("select id, mode, disabled_reason from sources order by id").all(),
      runs: db.query<RunRow, []>("select source_id, status, rows_in, http_status, error from fetch_runs order by id").all(),
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  buildApi(log);
  const app = getApp(APP);
  const dataDir = mkdtempSync(path.join(tmpdir(), `inversa-e2e-feeds-${APP}-`));
  const port = freePort();
  const api = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, INVERSA_DATA_DIR: dataDir, INVERSA_BIND: `127.0.0.1:${port}`, INVERSA_APPS: APP, INGEST_HOOK_SECRET: randomBytes(24).toString("hex"), RUST_LOG: "info" };
  delete env.INVERSA_SOURCES;
  const tail: string[] = [];
  const child = spawn(API_BIN, [], { cwd: REPO_DIR, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const keep = (b: Buffer) => {
    for (const line of b.toString().split("\n")) if (line.trim()) tail.push(line);
    if (tail.length > 300) tail.splice(0, tail.length - 300);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {}
      await Promise.race([new Promise((r) => child.once("exit", r)), Bun.sleep(10_000)]);
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    const bootDeadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`api exited ${child.exitCode}:\n${tail.slice(-30).join("\n")}`);
      const up = await fetch(`${api}/health`).then((r) => r.ok).catch(() => false);
      if (up) break;
      if (Date.now() > bootDeadline) throw new Error(`api not up in 60 s:\n${tail.slice(-30).join("\n")}`);
      await Bun.sleep(250);
    }
    const dbPath = path.join(dataDir, APP, "observations.db");
    if (!existsSync(dbPath)) throw new Error(`no ${dbPath}`);
    const started = Date.now();
    log(`api ${api}, data ${dataDir}; window up to ${WINDOW_MS / 1000} s; app feeds: ${app.feeds.map((f) => `${f.source}(${f.mode})`).join(" ")}`);

    let snap = read(dbPath);
    for (;;) {
      snap = read(dbPath);
      const runnable = snap.sources.filter((s) => !s.disabled_reason);
      const pending = runnable.filter((s) => s.mode !== "push" && !snap.runs.some((r) => r.source_id === s.id && OK.has(r.status)));
      if (runnable.length > 0 && pending.length === 0) break;
      if (Date.now() - started > WINDOW_MS) break;
      await Bun.sleep(3_000);
    }
    const elapsed = Math.round((Date.now() - started) / 1000);

    let fetched = 0;
    let failed = 0;
    let skipped = 0;
    let waiting = 0;
    let records = 0;
    for (const s of snap.sources) {
      const runs = snap.runs.filter((r) => r.source_id === s.id);
      const good = runs.filter((r) => OK.has(r.status));
      const rows = good.reduce((n, r) => n + r.rows_in, 0);
      const last = runs.at(-1);
      let verdict: string;
      if (s.disabled_reason && runs.length === 0) {
        skipped += 1;
        verdict = `skipped (${s.disabled_reason})`;
      } else if (good.length > 0) {
        fetched += 1;
        records += rows;
        verdict = "fetched";
      } else if (s.mode === "push" && runs.length === 0) {
        waiting += 1;
        verdict = "waiting (push, nothing delivered in the window)";
      } else {
        failed += 1;
        verdict = runs.length ? `failed: ${last?.status} http=${last?.http_status ?? "-"} ${last?.error ?? ""}` : "failed: no fetch in the window";
      }
      log(`${s.id.padEnd(18)} ${s.mode.padEnd(5)} runs=${runs.length} ok=${good.length} rows=${rows} ${verdict}`);
    }
    // Cross-check: what the API itself reports for the same feeds.
    const res = await fetch(`${api}/v1/${APP}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ feeds { source mode state lastFetchAt lastFetchRunId note } }" }) });
    const body = (await res.json()) as { data?: { feeds: { source: string; state: string; lastFetchAt: string | null; lastFetchRunId: string | null; note: string | null }[] } };
    const feeds = body.data?.feeds ?? [];
    for (const f of feeds) log(`graphql ${f.source}: ${f.state} last=${f.lastFetchAt ?? "-"} run=${f.lastFetchRunId ?? "-"} ${f.note ?? ""}`);
    const fetchedIds = snap.sources.filter((s) => snap.runs.some((r) => r.source_id === s.id && OK.has(r.status))).map((s) => s.id);
    const disagree = fetchedIds.filter((id) => !feeds.find((f) => f.source === id)?.lastFetchRunId);
    if (disagree.length) {
      log(`graphql reports no fetch run for ${disagree.join(", ")}`);
      failed += disagree.length;
    }
    log(`window ${elapsed} s`);
    console.log(`FEEDS app=${APP} fetched=${fetched} failed=${failed} skipped=${skipped} waiting=${waiting} records=${records}`);
    if (fetched < 3 || failed > 0 || records < 1) process.exitCode = 1;
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
