/**
 * Poll freshness (PRD §13 "Poll freshness ≤ cadence + 2 min", docs/perf.md) against the live upstreams.
 *
 *   bun e2e/perf-poll.ts [minutes]     default 70: long enough to see the hourly Open-Meteo poll come round
 *
 * Starts the release Axum on a free port over a fresh temp data dir with the pollers ON (no secrets: GOES and
 * NWWS stay disabled, every polled source runs), lets it poll for the given minutes while sampling `feeds`
 * every 30 s, then reads the source's own `fetch_runs` from that data dir. Per polled source:
 *
 * - `max_gap`: the longest time between consecutive fetches, and from the last fetch to the end of the run.
 *   A source polled on time never exceeds its cadence + 2 min. Sources whose cadence is longer than the run
 *   (NAS, GBIF: daily) are judged on the time to their first fetch and on the age at the end.
 * - `newest_lag`: the live `feeds` lag (now − newest observation) at the end, and the feed state; this is the
 *   upstream's own publishing delay, reported, not judged.
 *
 * Prints one `POLL <source> …` line per source and `POLL-SUMMARY pass=<n>/<n>`.
 */
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildApi, freePort, REPO_DIR } from "./stack";

const API_BIN = path.join(process.env.CARGO_TARGET_DIR ?? path.join(REPO_DIR, "api/target"), "release/inversa-api");
const MINUTES = Number(process.argv[2] ?? 70);
const GRACE_S = 120;
const log = (...a: unknown[]) => console.error("[perf:poll]", ...a);

type Feed = { source: string; mode: string; state: string; lagSeconds: number | null; lastFetchAt: string | null; note: string | null };

async function main() {
  buildApi(log);
  const dir = mkdtempSync(path.join(tmpdir(), "inversa-perf-poll-"));
  const port = freePort();
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(API_BIN, [], {
    cwd: REPO_DIR,
    env: { ...process.env, INVERSA_DATA_DIR: dir, INVERSA_BIND: `127.0.0.1:${port}`, RUST_LOG: "warn" },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  const errTail: string[] = [];
  child.stderr?.on("data", (b: Buffer) => {
    errTail.push(...b.toString().split("\n").filter(Boolean));
    errTail.splice(0, Math.max(0, errTail.length - 50));
  });
  const feeds = async (): Promise<Feed[]> => {
    const res = await fetch(`${api}/v1/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ feeds { source mode state lagSeconds lastFetchAt note } }" }),
    });
    return ((await res.json()) as { data: { feeds: Feed[] } }).data.feeds;
  };
  try {
    for (let i = 0; ; i++) {
      try {
        await feeds();
        break;
      } catch {
        if (i > 240 || child.exitCode !== null) throw new Error(`axum did not start:\n${errTail.join("\n")}`);
        await Bun.sleep(250);
      }
    }
    const startedAt = Date.now();
    log(`axum ${api} (data ${dir}); polling live upstreams for ${MINUTES} min`);
    const endAt = startedAt + MINUTES * 60_000;
    let last: Feed[] = [];
    while (Date.now() < endAt) {
      last = await feeds();
      const states = last.filter((f) => f.mode === "POLL").map((f) => `${f.source}:${f.state.toLowerCase()}`);
      log(`${Math.round((Date.now() - startedAt) / 60_000)} min: ${states.join(" ")}`);
      await Bun.sleep(Math.min(30_000, Math.max(0, endAt - Date.now())));
    }
    last = await feeds();
    const endedAt = Date.now();

    const db = new Database(path.join(dir, "observations.db"), { readonly: true });
    const sources = db.query("select id, cadence_s, mode, disabled_reason from sources where mode = 'poll' order by id").all() as {
      id: string;
      cadence_s: number;
      mode: string;
      disabled_reason: string | null;
    }[];
    let pass = 0;
    let judged = 0;
    for (const s of sources) {
      if (s.disabled_reason) {
        console.log(`POLL ${s.id} disabled (${s.disabled_reason})`);
        continue;
      }
      const runs = db.query("select fetched_at, status from fetch_runs where source_id = ? order by fetched_at").all(s.id) as { fetched_at: number; status: string }[];
      const times = [...new Set(runs.map((r) => r.fetched_at))];
      const firstAfter = times.length ? (times[0]! - startedAt) / 1000 : null;
      let maxGap = 0;
      for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap, (times[i]! - times[i - 1]!) / 1000);
      const endAge = times.length ? (endedAt - times.at(-1)!) / 1000 : Infinity;
      maxGap = Math.max(maxGap, endAge);
      const limit = s.cadence_s + GRACE_S;
      const ok = firstAfter !== null && firstAfter <= GRACE_S && maxGap <= limit;
      judged += 1;
      if (ok) pass += 1;
      const errors = runs.filter((r) => r.status === "error").length;
      const feed = last.find((f) => f.source === s.id);
      const coverage = s.cadence_s > MINUTES * 60 ? " (cadence longer than the run: first fetch and end age)" : "";
      console.log(
        `POLL ${s.id} cadence=${s.cadence_s}s limit=${limit}s fetches=${times.length} errors=${errors} first=${firstAfter?.toFixed(1)}s max_gap=${maxGap.toFixed(0)}s ` +
          `newest_lag=${feed?.lagSeconds ?? "-"}s state=${feed?.state.toLowerCase() ?? "-"} ${ok ? "PASS" : "FAIL"}${coverage}`,
      );
    }
    db.close();
    console.log(`POLL-SUMMARY minutes=${MINUTES} pass=${pass}/${judged}`);
    process.exitCode = pass === judged ? 0 : 1;
  } finally {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      // Gone.
    }
    await Bun.sleep(1000);
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
