/**
 * db worker (PRD §12 "New tech 2"): sqlite-wasm on the `opfs-sahpool` VFS, the CRDT tables, the query
 * cache and the frame grid. Only the leader tab spawns it (boot.ts). Everything behind the RPC lives in
 * `db/engine.ts`; this file binds the engine to sqlite-wasm, the worker scope and the gql port.
 *
 * sqlite-wasm constraints honoured here: the SAH pool must be installed from a dedicated worker (it uses
 * synchronous OPFS access handles), and one directory can be open in one worker at a time, which the
 * Web Locks election guarantees.
 */
import type { Database, Sqlite3Static, SqlValue as WasmSqlValue } from "@sqlite.org/sqlite-wasm";
import { get, set } from "@calvinjs/active-state";
import { connectThread, sabAvailable } from "@calvinjs/active-state/threads";

import { state } from "client/state";
import { MISSIONS, type MissionsState } from "client/state/missions";

import { DbEngine, type EngineGql } from "./db/engine";
import { isToDb, type FromDb } from "./db/rpc";
import { packTransfer, type SightingsPack } from "./db/sightings";
import { Store, type SqlDb, type SqlValue } from "./db/store";
import { appFromWorkerName, framesPath } from "./gql/client";
import { GqlRpcClient } from "./gql/protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

// Before the first await, so the host handshake is not missed.
connectThread(scope, state);

/** This worker serves one app (C-A5): boot.ts names it `inversa-db:<app>`; its frames and SQLite file are that app's. */
const APP = appFromWorkerName(scope.name);
const FRAMES_URL = new URL(framesPath(APP), scope.location.origin).href;
/**
 * The engine is served as static files (scripts/copy-sqlite-wasm.ts) and imported by URL: Turbopack cannot
 * bundle `@sqlite.org/sqlite-wasm` (its amalgam spawns a Worker from a dynamic URL). `import.meta.url` inside
 * the module then resolves `sqlite3.wasm` next to it.
 */
const SQLITE_WASM_URL = new URL("/sqlite-wasm/index.mjs", scope.location.origin).href;
/** One pool and file per app: the query cache and the CRDT board of one app never answer another's requests. */
const VFS_NAME = `inversa-db-${APP}`;
const DB_FILE = `/inversa-${APP}.sqlite3`;

const post = (event: FromDb, transfer?: Transferable[]) => scope.postMessage(event, transfer ?? []);

/** `Store`'s driver over a sqlite-wasm `Database`. */
function wrap(db: Database): SqlDb {
  return {
    run(sql, params = []) {
      db.exec({ sql, bind: params as WasmSqlValue[] });
    },
    all<T>(sql: string, params: SqlValue[] = []): T[] {
      return db.exec({ sql, bind: params as WasmSqlValue[], rowMode: "object", returnValue: "resultRows" }) as T[];
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(() => fn());
    },
  };
}

async function openDatabase(): Promise<{ db: Database; opfs: boolean }> {
  const mod = (await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ SQLITE_WASM_URL)) as { default: () => Promise<Sqlite3Static> };
  const sqlite3 = await mod.default();
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: VFS_NAME, initialCapacity: 6 });
    return { db: new pool.OpfsSAHPoolDb(DB_FILE), opfs: true };
  } catch (err) {
    console.warn("[threads/db] OPFS SAH pool unavailable, running in memory", err);
    return { db: new sqlite3.oo1.DB(":memory:"), opfs: false };
  }
}

let engine: DbEngine | null = null;
let pendingGql: EngineGql | null = null;

const ready: Promise<DbEngine> = openDatabase().then(({ db, opfs }) => {
  const store = new Store(wrap(db));
  store.migrate();
  engine = new DbEngine({
    store,
    gql: pendingGql,
    fetchImpl: (url, init) => fetch(url, init),
    framesUrl: FRAMES_URL,
    shared: sabAvailable(),
    opfs,
    post,
    onSummary: (s) => {
      set<MissionsState>(MISSIONS, (prev) => {
        const cur = prev ?? get<MissionsState>(MISSIONS);
        if (!cur || cur.boardId !== s.boardId) return cur as MissionsState;
        return { ...cur, lastSeq: s.lastSeq, missionCount: s.missionCount, removalTotal: s.removalTotal };
      });
    },
  });
  engine.housekeeping();
  post({ t: "db:ready", opfs });
  return engine;
});
ready.catch((err: unknown) => {
  console.error("[threads/db] init failed", err);
  post({ t: "db:error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
});

function linkGql(port: MessagePort): void {
  const client = new GqlRpcClient(port, "db");
  client.onMessage((m) => {
    if (m.t === "gql:frames-updated") void ready.then((e) => e.framesUpdated(m.from, m.to));
  });
  if (engine) engine.setGql(client);
  else pendingGql = client;
}

scope.addEventListener("message", (ev: MessageEvent) => {
  const m = ev.data as unknown;
  if (!isToDb(m)) return;
  if (m.t === "db:link-gql") {
    linkGql(m.port);
    return;
  }
  if (m.t !== "db:call") return;
  void ready
    .then((e) => e.call(m.method, m.params as never))
    .then((value) => {
      // `framesSnapshot` moves its copies instead of cloning ~36 MB twice.
      const transfer: Transferable[] = [];
      if (m.method === "framesSnapshot") {
        const snap = value as { buffer: ArrayBuffer | null; sightings: SightingsPack | null };
        if (snap.buffer) transfer.push(snap.buffer);
        if (snap.sightings) transfer.push(...packTransfer(snap.sightings));
      }
      post({ t: "db:ret", id: m.id, ok: true, value }, transfer);
    })
    .catch((err: unknown) => post({ t: "db:ret", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }));
});
