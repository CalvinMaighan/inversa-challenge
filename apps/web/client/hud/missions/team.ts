/**
 * The tab's team session: one HLC clock, the rtc link and the board model the panel renders. Write path
 * (PRD §12 "New tech 2"):
 *
 *   1. an edit builds ops with the clock (ME.nodeId);
 *   2. the rtc worker broadcasts them (< 150 ms to peers);
 *   3. `applyLocalOps` applies them optimistically and queues the outbox; `db:board` fires and the panel
 *      re-reads the board;
 *   4. the outbox flushes to `applyOps`, Axum publishes to the `ops` subscription (`syncBoard`), and the
 *      outbox entry is acked when the op echoes back.
 *
 * Duplicate delivery (a peer's channel and the WebSocket both carrying the same op) is harmless: apply is
 * idempotent on op id. On reconnect (`online`, and every RESYNC_MS) `syncBoard` pulls `opsSince` and flushes.
 */
import { get, set } from "@calvinjs/active-state";

import { DEBUG_HOOK } from "client/debug";
import { ensureIdentity, ME, type MeState } from "client/state/me";
import { DEFAULT_BOARD_ID, MISSIONS, type MissionsState } from "client/state/missions";
import type { Peer } from "client/state/peers";
import { SELECTION, type SelectionState } from "client/state/selection";
import { bootThreads, type Threads } from "client/threads/boot";
import { Clock, HlcDriftError } from "client/threads/crdt/hlc";
import type { BoardView } from "client/threads/crdt/merge";
import type { Op } from "client/threads/crdt/types";
import { startPeers, type TeamLink } from "client/threads/rtc/peers";

import { cell, type Cell } from "../store";
import { boardModel, messageOp, overlayOps, type BoardModel, type OpFactory } from "./board";

export const RESYNC_MS = 15_000;

export type Team = {
  readonly boardId: string;
  readonly nodeId: string;
  readonly board: Cell<BoardModel | null>;
  readonly link: TeamLink;
  readonly threads: Threads;
  factory(): OpFactory;
  /** Apply locally, broadcast to peers, queue for the server. Resolves once the local apply returned. */
  edit(ops: Op[]): Promise<void>;
  sync(): Promise<void>;
  close(): void;
};

let team: Team | null = null;

/** The live session for React (`useCell`); null before the panel started it. */
export const teamCell = cell<Team | null>(null);

export function currentTeam(): Team | null {
  return team;
}

type Harness = {
  nodeId: string;
  boardId: string;
  peers(): Peer[];
  board(): BoardModel | null;
  blockRtc(on: boolean): void;
  say(text: string): Promise<void>;
  select(evidenceId: string | null): void;
  sync(): Promise<void>;
};

declare global {
  interface Window {
    __team?: Harness;
  }
}

/** The singleton, started on first use (the panel mounts it). Needs a browser and a hydrated ME. */
export function ensureTeam(boardId: string = get<MissionsState>(MISSIONS)?.boardId ?? DEFAULT_BOARD_ID): Team {
  if (team && team.boardId === boardId) return team;
  team?.close();
  const me = ensureIdentity();
  const threads = bootThreads();
  const clock = new Clock(me.nodeId);
  const board = cell<BoardModel | null>(null);
  const link = startPeers({ boardId, me, threads });
  let closed = false;

  // The worker's last view, and this node's ops it may not include yet (`overlayOps`).
  let view: BoardView | null = null;
  const pending = new Map<string, Op>();
  const publish = () => {
    if (!closed && view) board.set(boardModel(overlayOps(view, [...pending.values()])));
  };
  const read = async () => {
    const next = await threads.db("readBoard", { boardId });
    if (closed) return;
    view = next;
    publish();
  };
  const sync = () =>
    threads
      .db("syncBoard", { boardId })
      .then(() => read())
      .catch((err: unknown) => console.warn("[team] sync", err));

  const offBoard = threads.onBoardChanged((id) => {
    if (id === boardId) void read().catch((err: unknown) => console.warn("[team] readBoard", err));
  });
  const offRemote = link.onRemoteOps((ops) => {
    for (const op of ops) {
      try {
        clock.receive(op.hlc);
      } catch (err) {
        if (!(err instanceof HlcDriftError)) throw err;
        console.warn("[team] peer clock too far ahead", op.hlc);
      }
    }
  });

  void threads.ready.then(sync, (err: unknown) => console.warn("[team] threads", err));
  const onOnline = () => {
    // The outbox backs off after a failed flush; sync now, then again once the first retry delays lapse.
    void sync();
    setTimeout(() => void sync(), 2_500);
  };
  window.addEventListener("online", onOnline);
  const resync = setInterval(() => void sync(), RESYNC_MS);

  const factory = (): OpFactory => ({ clock, boardId, nodeId: me.nodeId });
  const edit = async (ops: Op[]) => {
    if (ops.length === 0) return;
    // Optimistic: on screen in this frame, before the worker round trip. The overlay is dropped once a view
    // read after the commit includes the ops (or the commit failed, so the screen goes back to the truth).
    for (const op of ops) pending.set(op.id, op);
    publish();
    link.broadcast(ops);
    try {
      await threads.db("applyLocalOps", { boardId, ops });
      await read();
    } finally {
      for (const op of ops) pending.delete(op.id);
      publish();
    }
  };

  const t: Team = {
    boardId,
    nodeId: me.nodeId,
    board,
    link,
    threads,
    factory,
    edit,
    sync,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(resync);
      window.removeEventListener("online", onOnline);
      offBoard();
      offRemote();
      link.close();
      if (team === t) {
        team = null;
        teamCell.set(null);
      }
      if (DEBUG_HOOK) delete window.__team;
    },
  };
  team = t;
  teamCell.set(t);

  if (DEBUG_HOOK) {
    window.__team = {
      nodeId: me.nodeId,
      boardId,
      peers: () => link.peers(),
      board: () => board.get(),
      blockRtc: (on) => link.setBlocked(on),
      say: (text) => edit([messageOp(factory(), text)]),
      select: (evidenceId) => set<SelectionState>(SELECTION, (prev) => ({ ...SELECTION.defaults, ...prev, evidenceId })),
      sync,
    };
  }
  return t;
}

/** Callsign for a node id: me, a live peer, or the id's head. */
export function callsignOf(nodeId: string, peers: readonly Peer[], me: MeState | undefined): string {
  if (me && nodeId === me.nodeId) return me.callsign || "me";
  return peers.find((p) => p.peerId === nodeId)?.callsign ?? nodeId.slice(0, 8);
}

export { ME };
