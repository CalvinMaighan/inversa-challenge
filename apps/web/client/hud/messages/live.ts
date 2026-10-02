/**
 * Live text streams over the team link (PLAN.md C-A7, M1): the glue between `rtc/stream.ts` (pure algebra) and
 * the app state. One instance per team session (`team.ts`).
 *
 * Author side: `dm(to)` and `note(noteId)` hand back a composer; `update(text)` on every input, and the composer
 * sends a delta at once, or at most one per frame interval while keys come faster than that, to the peer (DM)
 * or to every open channel (note). Receiver side:
 * every incoming delta runs through a `StreamReceiver` per stream and lands in MESSAGES (`drafts`, `typing`) or
 * NOTES (`live`). A gap asks the author for a `stream.sync`; a closed channel drops that peer's streams; typing
 * presence clears `TYPING_TTL_MS` after the last delta. No DOM beyond `requestAnimationFrame`.
 */
import { get } from "@calvinjs/active-state";

import { dmThread, MESSAGES, setDmDraft, setDmTyping, type MessagesState } from "client/state/messages";
import { NOTES, setNoteLive, type NotesState } from "client/state/notes";
import type { StreamMessage } from "client/threads/rtc/protocol";
import { StreamReceiver, StreamSender, TYPING_TTL_MS } from "client/threads/rtc/stream";

import { uuidv7 } from "../missions/board";

/** A `dm.typing on` goes out at most this often while the author keeps typing. */
export const TYPING_HEARTBEAT_MS = 1_000;
/** Resync requests for one stream, at most one per this interval. */
const RESYNC_MIN_MS = 250;
/** Typing presence is swept this often. */
const SWEEP_MS = 500;

export type LiveLink = {
  send(to: string | null, msg: StreamMessage): void;
  onStream(cb: (msg: StreamMessage) => void): () => void;
  onLink(cb: (peerId: string, state: "open" | "closed") => void): () => void;
};

export type DmComposer = {
  readonly thread: string;
  readonly to: string;
  /** The whole textarea value after an input event. Sends nothing while `composing`. */
  update(text: string, composing?: boolean): void;
  /** Send `dm.commit` and persist; resolves with the message id. Empty text just cancels. */
  commit(): Promise<string | null>;
  /** Drop the draft: typing off, peers clear it. */
  cancel(): void;
};

export type NoteEditor = {
  readonly noteId: string;
  update(text: string, composing?: boolean): void;
  /** Editing ended (saved or cancelled): the last text goes out so peers converge, then the stream stops. */
  done(): void;
};

export type LiveStreams = {
  dm(to: string): DmComposer;
  note(noteId: string, initial: string): NoteEditor;
  close(): void;
};

export type LiveOptions = {
  link: LiveLink;
  nodeId: string;
  /**
   * Persist a committed DM as the CRDT message. `hlc` is the op's clock stamp, known before the write so the
   * `dm.commit` can carry it and go out ahead of the op broadcast; `done` resolves once the local apply returned.
   */
  persistDm(msgId: string, to: string, thread: string, text: string): { hlc: string; done: Promise<void> };
  now?: () => number;
  /** Run `cb` after `delayMs` (a timer); tests substitute a queue. */
  schedule?: (cb: () => void, delayMs: number) => void;
};

type Inbound = { receiver: StreamReceiver; from: string; resyncAt: number };

export function startLiveStreams(o: LiveOptions): LiveStreams {
  const { link, nodeId } = o;
  const now = o.now ?? (() => Date.now());
  const schedule = o.schedule ?? ((cb: () => void, delayMs: number) => void setTimeout(cb, delayMs));
  const inbound = new Map<string, Inbound>();
  const dmSenders = new Map<string, { to: string; sender: StreamSender }>();
  const noteSenders = new Map<string, StreamSender>();
  let closed = false;

  const streamKey = (kind: "dm" | "note", id: string) => `${kind}:${id}`;

  // ---- receiving ------------------------------------------------------------------------------------

  const inboundFor = (kind: "dm" | "note", id: string, from: string): Inbound => {
    const key = streamKey(kind, id);
    let s = inbound.get(key);
    if (!s || s.from !== from) {
      s = { receiver: new StreamReceiver(), from, resyncAt: Number.NEGATIVE_INFINITY };
      inbound.set(key, s);
    }
    return s;
  };

  const askSync = (kind: "dm" | "note", id: string, s: Inbound) => {
    const t = now();
    if (t - s.resyncAt < RESYNC_MIN_MS) return;
    s.resyncAt = t;
    link.send(s.from, { type: "stream.resync", kind, id, from: nodeId });
  };

  const publishDm = (thread: string, msgId: string, s: Inbound) => {
    setDmDraft(thread, { msgId, from: s.from, text: s.receiver.text, caret: s.receiver.caret, at: now() });
    setDmTyping(thread, now());
  };

  const publishNote = (noteId: string, s: Inbound) => {
    setNoteLive(noteId, { from: s.from, text: s.receiver.text, caret: s.receiver.caret, at: now() });
  };

  const receive = (msg: StreamMessage) => {
    if (closed) return;
    switch (msg.type) {
      case "dm.delta": {
        const thread = dmThread(nodeId, msg.from);
        if (msg.thread !== thread) return;
        const s = inboundFor("dm", msg.msgId, msg.from);
        const outcome = s.receiver.receive({ seq: msg.seq, del: msg.del, ins: msg.ins });
        if (outcome === "gap") askSync("dm", msg.msgId, s);
        if (outcome === "applied") publishDm(thread, msg.msgId, s);
        else setDmTyping(thread, now());
        return;
      }
      case "dm.typing": {
        const thread = dmThread(nodeId, msg.from);
        if (msg.thread !== thread) return;
        if (msg.on) setDmTyping(thread, now());
        else {
          setDmTyping(thread, null);
          setDmDraft(thread, null);
        }
        return;
      }
      case "dm.commit": {
        const thread = dmThread(nodeId, msg.from);
        if (msg.thread !== thread) return;
        inbound.delete(streamKey("dm", msg.msgId));
        setDmDraft(thread, null);
        setDmTyping(thread, null);
        return;
      }
      case "note.delta": {
        const s = inboundFor("note", msg.noteId, msg.from);
        const outcome = s.receiver.receive({ seq: msg.seq, del: msg.del, ins: msg.ins });
        if (outcome === "gap") askSync("note", msg.noteId, s);
        if (outcome === "applied") publishNote(msg.noteId, s);
        return;
      }
      case "stream.sync": {
        const s = inboundFor(msg.kind, msg.id, msg.from);
        s.receiver.sync(msg.seq, msg.text);
        if (msg.kind === "dm") publishDm(dmThread(nodeId, msg.from), msg.id, s);
        else publishNote(msg.id, s);
        return;
      }
      case "stream.resync": {
        if (msg.kind === "dm") {
          const d = dmSenders.get(msg.id);
          if (d && d.to === msg.from) link.send(msg.from, { type: "stream.sync", kind: "dm", id: msg.id, from: nodeId, ...d.sender.snapshot() });
        } else {
          const sender = noteSenders.get(msg.id);
          if (sender) link.send(msg.from, { type: "stream.sync", kind: "note", id: msg.id, from: nodeId, ...sender.snapshot() });
        }
        return;
      }
    }
  };

  const onLink = (peerId: string, state: "open" | "closed") => {
    if (closed) return;
    if (state === "closed") {
      // Whatever that peer was streaming is gone with the channel: no ghost draft, no ghost "typing".
      for (const [key, s] of inbound) {
        if (s.from !== peerId) continue;
        inbound.delete(key);
        const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
        if (kind === "note") setNoteLive(id, null);
      }
      const thread = dmThread(nodeId, peerId);
      setDmDraft(thread, null);
      setDmTyping(thread, null);
      return;
    }
    // Reconnect: the peer missed every delta while the channel was down; hand it the whole text.
    for (const [msgId, d] of dmSenders) if (d.to === peerId && d.sender.seq > 0) link.send(peerId, { type: "stream.sync", kind: "dm", id: msgId, from: nodeId, ...d.sender.snapshot() });
    for (const [noteId, sender] of noteSenders) if (sender.seq > 0) link.send(peerId, { type: "stream.sync", kind: "note", id: noteId, from: nodeId, ...sender.snapshot() });
  };

  const sweep = () => {
    if (closed) return;
    const t = now();
    const m = get<MessagesState>(MESSAGES) ?? MESSAGES.defaults;
    for (const [thread, at] of Object.entries(m.typing)) if (t - at > TYPING_TTL_MS) setDmTyping(thread, null);
    const n = get<NotesState>(NOTES) ?? NOTES.defaults;
    for (const [noteId, live] of Object.entries(n.live)) if (t - live.at > TYPING_TTL_MS) setNoteLive(noteId, null);
  };

  const offStream = link.onStream(receive);
  const offLink = link.onLink(onLink);
  const sweeper = setInterval(sweep, SWEEP_MS);

  // ---- sending --------------------------------------------------------------------------------------

  const dm = (to: string): DmComposer => {
    const thread = dmThread(nodeId, to);
    let msgId = uuidv7(now());
    const sender = new StreamSender();
    let scheduled = false;
    let typingAt = Number.NEGATIVE_INFINITY;
    let composing = false;
    dmSenders.set(msgId, { to, sender });

    // A key outside the frame interval goes out at once; keys inside it coalesce into one delta at its end.
    const flush = () => {
      scheduled = false;
      if (closed || composing) return;
      const d = sender.flush(now());
      if (d) {
        link.send(to, { type: "dm.delta", thread, msgId, from: nodeId, to, seq: d.seq, at: now(), del: d.del, ins: d.ins });
        if (now() - typingAt >= TYPING_HEARTBEAT_MS) {
          typingAt = now();
          link.send(to, { type: "dm.typing", thread, from: nodeId, on: true });
        }
      }
      if (sender.dirty()) arm();
    };
    const arm = () => {
      if (scheduled) return;
      const wait = sender.wait(now());
      if (wait === 0) return flush();
      scheduled = true;
      schedule(flush, wait);
    };
    const fresh = () => {
      dmSenders.delete(msgId);
      msgId = uuidv7(now());
      sender.reset();
      typingAt = Number.NEGATIVE_INFINITY;
      dmSenders.set(msgId, { to, sender });
    };

    const cancel = () => {
      composing = false;
      if (sender.seq > 0 || typingAt > Number.NEGATIVE_INFINITY) link.send(to, { type: "dm.typing", thread, from: nodeId, on: false });
      fresh();
    };

    return {
      thread,
      to,
      update(text, isComposing = false) {
        composing = isComposing;
        sender.update(text);
        if (!composing) arm();
      },
      async commit() {
        composing = false;
        const text = sender.text.trim();
        if (!text) {
          cancel();
          return null;
        }
        const id = msgId;
        const { hlc, done } = o.persistDm(id, to, thread, text);
        // The commit goes out first, so the peer swaps the draft for the message in one step when the op lands.
        link.send(to, { type: "dm.commit", thread, msgId: id, from: nodeId, to, text, hlc });
        link.send(to, { type: "dm.typing", thread, from: nodeId, on: false });
        fresh();
        await done;
        return id;
      },
      cancel,
    };
  };

  const note = (noteId: string, initial: string): NoteEditor => {
    const sender = new StreamSender();
    sender.reset(initial);
    let scheduled = false;
    let composing = false;
    noteSenders.set(noteId, sender);
    // Peers start from the saved text, so a sync at seq 0 anchors every delta that follows.
    link.send(null, { type: "stream.sync", kind: "note", id: noteId, from: nodeId, seq: 0, text: initial });

    const flush = () => {
      scheduled = false;
      if (closed || composing || noteSenders.get(noteId) !== sender) return;
      const d = sender.flush(now());
      if (d) link.send(null, { type: "note.delta", noteId, from: nodeId, seq: d.seq, del: d.del, ins: d.ins });
      if (sender.dirty()) arm();
    };
    const arm = () => {
      if (scheduled) return;
      const wait = sender.wait(now());
      if (wait === 0) return flush();
      scheduled = true;
      schedule(flush, wait);
    };
    return {
      noteId,
      update(text, isComposing = false) {
        composing = isComposing;
        sender.update(text);
        if (!composing) arm();
      },
      done() {
        composing = false;
        const d = sender.flush(Number.POSITIVE_INFINITY);
        if (d) link.send(null, { type: "note.delta", noteId, from: nodeId, seq: d.seq, del: d.del, ins: d.ins });
        if (noteSenders.get(noteId) === sender) noteSenders.delete(noteId);
      },
    };
  };

  return {
    dm,
    note,
    close() {
      closed = true;
      clearInterval(sweeper);
      offStream();
      offLink();
    },
  };
}
