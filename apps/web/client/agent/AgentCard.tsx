"use client";

import { memo, useCallback, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";

import type { VoiceState } from "client/state/voice";

import {
  Assistant,
  Composer,
  Empty,
  ErrorLine,
  Header,
  IconButton,
  Input,
  Note,
  PhaseLine,
  Reasoning,
  SendButton,
  SourceChip,
  Sources,
  Status,
  Thread,
  Title,
  UserBubble,
  VoiceBar,
  VoiceDot,
  VoiceLine,
  VoiceTag,
} from "./card.styled";
import ActionTimeline from "./chat/ActionTimeline";
import { formatWorkDuration } from "./chat/tools";
import type { AgentThread, AgentTurn } from "./chat/thread";
import { ClearIcon, CloseIcon, MicIcon, SendIcon, StopIcon } from "./icons";
import StreamMarkdown from "./markdown/StreamMarkdown";
import { ORB_LABELS, voiceIsLive, type OrbPhase } from "./orb-phase";
import DataPanels from "./panels/DataPanels";
import ExpandedPanels from "./panels/ExpandedPanels";

/** Route limit (app/api/agent/stream: MAX_QUESTION_CHARS). */
const MAX_QUESTION_CHARS = 4_000;
/** Distance from the bottom that still counts as "following" the stream. */
const STICK_PX = 48;

export type CardVoice = Partial<VoiceState>;

const PHASE_TEXT: Record<NonNullable<AgentTurn["phase"]>, string> = {
  thinking: "Thinking…",
  reading: "Reading data…",
  generating: "Writing…",
};

function ReasoningBlock({ turn }: { turn: AgentTurn }) {
  if (!turn.reasoning?.trim()) return null;
  const ms = turn.reasoningStartedAtMs !== undefined && turn.reasoningEndedAtMs !== undefined ? turn.reasoningEndedAtMs - turn.reasoningStartedAtMs : null;
  return (
    <Reasoning>
      <summary>{ms === null ? "Thinking…" : `Thought for ${formatWorkDuration(ms, false)}`}</summary>
      <p>{turn.reasoning}</p>
    </Reasoning>
  );
}

/** Memoized: the reducer replaces only the turn that changed, so a streaming turn re-renders alone. */
const AssistantTurn = memo(function AssistantTurn({
  turn,
  objective,
  selected,
  onCite,
  onExpand,
}: {
  turn: AgentTurn;
  /** Voice task objective, for voice turns. */
  objective: string | undefined;
  selected: string | null;
  onCite: (id: string) => void;
  onExpand: (turnId: string) => void;
}) {
  const streaming = turn.status === "streaming";
  return (
    <Assistant data-turn={turn.id} data-source={turn.source ?? "text"} data-status={turn.status} aria-busy={streaming}>
      {turn.source === "voice" ? <VoiceTag title={objective}>{objective ? `voice · ${objective}` : "voice"}</VoiceTag> : null}
      <ReasoningBlock turn={turn} />
      <ActionTimeline turn={turn} />
      {streaming && !turn.text && turn.phase ? <PhaseLine>{PHASE_TEXT[turn.phase]}</PhaseLine> : null}
      {turn.text ? <StreamMarkdown text={turn.text} citations={turn.citations} onCite={onCite} /> : null}
      <DataPanels turnId={turn.id} onExpand={onExpand} />
      {turn.stopped ? <Note>Stopped.</Note> : null}
      {turn.errors?.map((message, i) => (
        <ErrorLine key={i} role="alert">
          {message}
        </ErrorLine>
      ))}
      {turn.citations.length > 0 && !streaming ? (
        <Sources aria-label="Evidence">
          {turn.citations.map((c, i) => (
            <SourceChip
              key={c.id}
              type="button"
              title={c.label}
              data-evidence-id={c.id}
              aria-current={selected === c.id ? "true" : undefined}
              onClick={() => onCite(c.id)}
            >
              <b>{i + 1}</b>
              <span>{c.label}</span>
            </SourceChip>
          ))}
        </Sources>
      ) : null}
    </Assistant>
  );
});

function VoiceStrip({ voice }: { voice: CardVoice | undefined }) {
  if (!voice || (voice.status !== "live" && voice.status !== "connecting" && !(voice.status === "error" && voice.error))) return null;
  if (voice.status === "error") {
    return (
      <VoiceBar role="status">
        <VoiceDot $active={false} />
        <VoiceLine>{voice.error}</VoiceLine>
      </VoiceBar>
    );
  }
  const line = voice.state === "speaking" ? voice.assistantText : voice.userText;
  return (
    <VoiceBar role="status">
      <VoiceDot $active={voice.status === "live"} />
      <span>{voice.status === "connecting" ? "Connecting…" : voice.state === "idle" ? "Voice on" : voice.state}</span>
      <VoiceLine>{line}</VoiceLine>
    </VoiceBar>
  );
}

export type AgentCardProps = {
  thread: AgentThread;
  asking: boolean;
  phase: OrbPhase;
  voice: CardVoice | undefined;
  selected: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: (question: string) => Promise<boolean>;
  onStop: () => void;
  onClear: () => void;
  onCite: (id: string) => void;
  onToggleVoice: () => void;
  onClose: () => void;
};

/** Chat card body: header, transcript, composer. The morph portal owns placement. */
export default function AgentCard({
  thread,
  asking,
  phase,
  voice,
  selected,
  inputRef,
  onSend,
  onStop,
  onClear,
  onCite,
  onToggleVoice,
  onClose,
}: AgentCardProps) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const closeExpanded = useCallback(() => setExpanded(null), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const live = voiceIsLive(voice);

  // Follow the stream while the reader is at the bottom; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread.messages]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const question = draft.trim();
    if (!question || asking) return;
    setDraft("");
    stick.current = true;
    const sent = await onSend(question);
    if (!sent) setDraft(question);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  return (
    <>
      <Header>
        <Title>
          Agent <Status aria-live="polite">· {ORB_LABELS[phase].toLowerCase()}</Status>
        </Title>
        <IconButton type="button" aria-label={live ? "Stop voice" : "Start voice"} aria-pressed={live} onClick={onToggleVoice}>
          <MicIcon />
        </IconButton>
        <IconButton type="button" aria-label="Clear conversation" disabled={asking || thread.messages.length === 0} onClick={onClear}>
          <ClearIcon />
        </IconButton>
        <IconButton type="button" aria-label="Close agent chat" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </Header>
      <VoiceStrip voice={voice} />
      <Thread
        ref={scrollRef}
        role="log"
        aria-label="Conversation"
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
      >
        {thread.messages.length === 0 ? (
          <Empty>Ask about sightings, hotspots, conditions or alerts in view. Answers cite their evidence.</Empty>
        ) : (
          thread.messages.map((turn) =>
            turn.role === "user" ? (
              <UserBubble key={turn.id} data-turn={turn.id}>
                {turn.text}
              </UserBubble>
            ) : (
              <AssistantTurn
                key={turn.id}
                turn={turn}
                objective={turn.taskId ? voice?.tasks?.find((t) => t.id === turn.taskId)?.objective : undefined}
                selected={selected}
                onCite={onCite}
                onExpand={setExpanded}
              />
            ),
          )
        )}
      </Thread>
      {expanded && thread.messages.some((m) => m.id === expanded) ? <ExpandedPanels turnId={expanded} onClose={closeExpanded} /> : null}
      <Composer onSubmit={submit}>
        <Input
          ref={inputRef}
          rows={1}
          value={draft}
          maxLength={MAX_QUESTION_CHARS}
          placeholder="Ask the field agent…"
          aria-label="Question"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {asking ? (
          <SendButton type="button" aria-label="Stop answer" onClick={onStop}>
            <StopIcon />
          </SendButton>
        ) : (
          <SendButton type="submit" aria-label="Send question" disabled={!draft.trim()}>
            <SendIcon />
          </SendButton>
        )}
      </Composer>
    </>
  );
}
