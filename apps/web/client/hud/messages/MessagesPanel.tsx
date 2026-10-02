"use client";

/**
 * Direct messages (PLAN.md C-A7, M1): a thread per peer. The other side sees every keystroke as it is typed
 * (`dm.delta` over the data channel, `live.ts`), with the author's caret and an "is typing" line; Enter commits
 * the text as a CRDT `message` with `to` and `thread`, so it survives a reload and reaches peers that were
 * offline. Text is plain everywhere: React text nodes, never HTML or markdown. Native buttons and a textarea,
 * so it works from the keyboard and inside the phone sheet.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import { colorOfNode, type MeState } from "client/state/me";
import { dmThread, MESSAGES, setDmPeer, type LiveDraft, type MessagesState } from "client/state/messages";
import type { Peer } from "client/state/peers";
import type { MessageView } from "client/threads/crdt/merge";
import styled from "client/styled";

import type { Team } from "../missions/team";
import { Dot, IconButton, Mono, Pill, SectionTitle } from "../primitives";
import { MAX_DM_CHARS, threadMessages, threadRows, type DmThreadRow } from "./model";

/** Relative times and presence refresh this often. */
const CLOCK_MS = 5_000;

const Section = styled.section`
  display: flex;
  flex-direction: column;
  gap: var(--gap-s);
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  flex-wrap: wrap;
`;

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const ThreadButton = styled.button`
  display: flex;
  width: 100%;
  align-items: center;
  gap: var(--gap-s);
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  text-align: left;
  font: inherit;
  cursor: pointer;
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
`;

const Preview = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 12px;
`;

const Log = styled.ol`
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 220px;
  overflow: auto;
  font-size: 12px;
  li {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
`;

const Author = styled.span<{ $color: string }>`
  color: ${(p) => p.$color};
  font: 600 11px var(--font-mono);
  white-space: nowrap;
`;

/** Message and live text: a text node, wrapped as written. */
const Text = styled.span`
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

const Live = styled.li`
  color: var(--muted);
  font-style: italic;
`;

/** The author's caret inside their live text: a thin bar in the author's colour. */
const Caret = styled.span<{ $color: string }>`
  display: inline-block;
  width: 2px;
  height: 1em;
  margin: 0 1px;
  vertical-align: text-bottom;
  background: ${(p) => p.$color};
  box-shadow: 0 0 4px ${(p) => p.$color};
`;

const Typing = styled.p`
  margin: 0;
  min-height: 1.2em;
  color: var(--muted);
  font-size: 11px;
`;

const Hint = styled.p`
  margin: 0;
  color: var(--muted);
  font-size: 12px;
`;

const TextArea = styled.textarea`
  width: 100%;
  min-height: 44px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: color-mix(in oklch, var(--surface) 60%, transparent);
  color: var(--text);
  font: 13px / 1.4 var(--font-ui);
  resize: vertical;
  box-sizing: border-box;
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
`;

const Counter = styled.span`
  margin-left: auto;
  color: var(--muted);
  font: 11px var(--font-mono);
`;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, []);
  return now;
}

const PRESENCE_LABEL = { online: "online", away: "away" } as const;

function ThreadList({ rows, onOpen }: { rows: DmThreadRow[]; onOpen: (peerId: string) => void }) {
  if (rows.length === 0) return <Hint data-testid="dm-empty">Nobody else is on the board yet. Direct messages start here once a peer joins.</Hint>;
  return (
    <List data-testid="dm-threads">
      {rows.map((r) => (
        <li key={r.peerId}>
          <ThreadButton type="button" onClick={() => onOpen(r.peerId)} data-testid="dm-thread" data-peer-id={r.peerId} data-presence={r.presence} aria-label={`Message ${r.callsign}, ${PRESENCE_LABEL[r.presence]}`}>
            <Dot $tone={r.presence === "online" ? "ok" : "muted"} style={r.presence === "online" ? { background: r.color, boxShadow: `0 0 6px ${r.color}` } : undefined} />
            <Mono>{r.callsign}</Mono>
            <Pill $tone={r.presence === "online" ? "ok" : "muted"}>{PRESENCE_LABEL[r.presence]}</Pill>
            <Preview>{r.last ? r.last.body : "No messages yet"}</Preview>
          </ThreadButton>
        </li>
      ))}
    </List>
  );
}

/** The peer's unsaved text with their caret where it is. */
function LiveText({ text, caret, color }: { text: string; caret: number; color: string }) {
  const at = Math.max(0, Math.min(caret, text.length));
  return (
    <Text data-testid="dm-live-text">
      {text.slice(0, at)}
      <Caret $color={color} data-testid="dm-caret" aria-hidden="true" />
      {text.slice(at)}
    </Text>
  );
}

/** The thread's messages and the peer's live draft: text nodes only, no hooks (so it renders anywhere). */
export function DmLog({
  messages,
  draft,
  nameOf,
  colorOf,
  logRef,
}: {
  messages: readonly MessageView[];
  draft: LiveDraft | null;
  nameOf: (nodeId: string) => string;
  colorOf: (nodeId: string) => string;
  logRef?: RefObject<HTMLOListElement | null>;
}) {
  return (
    <Log ref={logRef} data-testid="dm-log" aria-live="polite" aria-label="Messages">
      {messages.map((m) => (
        <li key={m.id} data-testid="dm-message" data-message-id={m.id} data-from={m.nodeId}>
          <Author $color={colorOf(m.nodeId)}>{nameOf(m.nodeId)}</Author>
          <Text>{m.body}</Text>
        </li>
      ))}
      {draft && (
        <Live data-testid="dm-live" data-from={draft.from} data-msg-id={draft.msgId}>
          <Author $color={colorOf(draft.from)}>{nameOf(draft.from)}</Author>
          <LiveText text={draft.text} caret={draft.caret} color={colorOf(draft.from)} />
        </Live>
      )}
    </Log>
  );
}

function Thread({ team, me, peer, peers, messages }: { team: Team; me: MeState | undefined; peer: DmThreadRow; peers: Peer[]; messages: readonly MessageView[] }) {
  const thread = dmThread(team.nodeId, peer.peerId);
  const mine = useMemo(() => threadMessages(messages, thread), [messages, thread]);
  const [state] = useActiveState<MessagesState>(MESSAGES);
  const draft = state?.drafts[thread] ?? null;
  const typingAt = state?.typing[thread] ?? null;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLOListElement>(null);

  // One composer per open thread; closing the thread or switching peers cancels the draft for the other side.
  const composer = useMemo(() => team.live.dm(peer.peerId), [team, peer.peerId]);
  useEffect(() => () => composer.cancel(), [composer]);
  useEffect(() => {
    textRef.current?.focus();
  }, [composer]);
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [mine.length, draft?.text]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      // `commit` sends the `dm.commit` and stamps the op before its first await: the box clears in this frame
      // (PRD §13 "optimistic edit, local: same frame") and the write to the db worker is awaited after.
      const done = composer.commit();
      setText("");
      await done;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape" && text) {
      e.preventDefault();
      composer.cancel();
      setText("");
    }
  };
  const colorOf = (nodeId: string) => (me && nodeId === me.nodeId ? me.color : (peers.find((p) => p.peerId === nodeId)?.color ?? colorOfNode(nodeId)));
  const nameOf = (nodeId: string) => (me && nodeId === me.nodeId ? me.callsign || "me" : nodeId === peer.peerId ? peer.callsign : nodeId.slice(0, 8));
  // `live.ts` sweeps typing presence TYPING_TTL_MS after the last delta, so its presence in state is the signal.
  const typing = typingAt !== null;

  return (
    <Section aria-label={`Direct messages with ${peer.callsign}`} data-testid="dm-thread-open" data-peer-id={peer.peerId} data-presence={peer.presence}>
      <Row>
        <IconButton type="button" onClick={() => setDmPeer(null)} aria-label="Back to the thread list" data-testid="dm-back">
          ‹ All
        </IconButton>
        <Dot $tone={peer.presence === "online" ? "ok" : "muted"} style={peer.presence === "online" ? { background: peer.color, boxShadow: `0 0 6px ${peer.color}` } : undefined} />
        <Mono>{peer.callsign}</Mono>
        <Pill $tone={peer.presence === "online" ? "ok" : "muted"} data-testid="dm-presence">
          {PRESENCE_LABEL[peer.presence]}
        </Pill>
      </Row>
      <DmLog messages={mine} draft={draft} nameOf={nameOf} colorOf={colorOf} logRef={logRef} />
      <Typing aria-live="polite" data-testid="dm-typing" data-on={typing ? "1" : "0"}>
        {typing ? `${peer.callsign} is typing…` : ""}
      </Typing>
      <Section as="form" aria-label="Write a direct message" onSubmit={send}>
        <TextArea
          ref={textRef}
          value={text}
          maxLength={MAX_DM_CHARS}
          placeholder={`Message ${peer.callsign} — they see it as you type`}
          aria-label={`Message to ${peer.callsign}`}
          onChange={(e) => {
            setText(e.target.value);
            composer.update(e.target.value, composing.current);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            composer.update(e.currentTarget.value, false);
          }}
          onKeyDown={onKey}
          data-testid="dm-text"
        />
        {error && (
          <Hint role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </Hint>
        )}
        <Row>
          <IconButton type="submit" $active disabled={busy || !text.trim()} data-testid="dm-send">
            Send
          </IconButton>
          <Hint>Enter sends, Shift+Enter breaks a line, Esc clears.</Hint>
          <Counter aria-live="polite">
            {text.length}/{MAX_DM_CHARS}
          </Counter>
        </Row>
      </Section>
    </Section>
  );
}

/** The Direct messages section of the Notes tab: a thread list, or one open thread. */
export default function MessagesPanel({ team, me, peers, messages }: { team: Team; me: MeState | undefined; peers: Peer[]; messages: readonly MessageView[] }) {
  const now = useNow();
  const peerId = useActiveState<MessagesState, string | null>(MESSAGES, (s) => s.peer)[0] ?? null;
  const rows = useMemo(() => threadRows(messages, peers, team.nodeId, now), [messages, peers, team.nodeId, now]);
  const open = peerId ? (rows.find((r) => r.peerId === peerId) ?? null) : null;
  return (
    <Section aria-label="Direct messages" data-testid="dm-panel">
      <SectionTitle>Direct messages</SectionTitle>
      {open ? <Thread team={team} me={me} peer={open} peers={peers} messages={messages} /> : <ThreadList rows={rows} onOpen={setDmPeer} />}
    </Section>
  );
}
