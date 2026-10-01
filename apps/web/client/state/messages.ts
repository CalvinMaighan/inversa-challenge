import { key, set } from "@calvinjs/active-state";

/**
 * Direct messages (PLAN.md C-A7, M1): the thread the panel has open, and what peers are typing right now. The
 * committed messages themselves are `message` entities on the CRDT board (`to` and `thread` set); this key only
 * carries the live, unsaved part: a peer's draft as it streams in, character by character, and typing presence.
 */
export type LiveDraft = {
  msgId: string;
  /** The author's node id (the channel's peer id, set by the rtc worker). */
  from: string;
  text: string;
  /** The author's caret, in UTF-16 code units of `text`. */
  caret: number;
  /** Last delta, ms since epoch. */
  at: number;
};

export type MessagesState = {
  /** The peer whose thread is open, or null for the thread list. */
  peer: string | null;
  /** Incoming drafts by thread id. */
  drafts: Record<string, LiveDraft>;
  /** Typing presence by thread id: ms when a peer last said it was typing. */
  typing: Record<string, number>;
};

const defaults: MessagesState = { peer: null, drafts: {}, typing: {} };

export const MESSAGES = key("MESSAGES", defaults);

/** The thread two nodes share, the same from either side. */
export function dmThread(a: string, b: string): string {
  return `dm:${[a, b].sort().join("~")}`;
}

/** The other node of a thread, or null when `me` is not in it. */
export function peerOfThread(thread: string, me: string): string | null {
  if (!thread.startsWith("dm:")) return null;
  const [a, b] = thread.slice(3).split("~");
  if (a === me && b !== undefined) return b;
  if (b === me && a !== undefined) return a;
  return null;
}

export function setDmPeer(peer: string | null): void {
  set<MessagesState>(MESSAGES, (prev = MESSAGES.defaults) => (prev.peer === peer ? prev : { ...prev, peer }));
}

/** A peer's draft in `thread`, or null when it stopped (commit, cancel, channel closed). */
export function setDmDraft(thread: string, draft: LiveDraft | null): void {
  set<MessagesState>(MESSAGES, (prev = MESSAGES.defaults) => {
    if (draft === null) {
      if (!(thread in prev.drafts)) return prev;
      const drafts = { ...prev.drafts };
      delete drafts[thread];
      return { ...prev, drafts };
    }
    return { ...prev, drafts: { ...prev.drafts, [thread]: draft } };
  });
}

/** Typing presence for `thread`: the time it was asserted, or null to clear. */
export function setDmTyping(thread: string, at: number | null): void {
  set<MessagesState>(MESSAGES, (prev = MESSAGES.defaults) => {
    if (at === null) {
      if (!(thread in prev.typing)) return prev;
      const typing = { ...prev.typing };
      delete typing[thread];
      return { ...prev, typing };
    }
    return { ...prev, typing: { ...prev.typing, [thread]: at } };
  });
}
