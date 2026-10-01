"use client";

import { memo, useCallback, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";

import { EXAMPLE_QUESTIONS, FIRST_VISIT_HINT } from "client/hud/help/content";
import type { VoiceState } from "client/state/voice";

import {
  Assistant,
  Composer,
  Empty,
  ErrorLine,
  Header,
  Hint,
  HintChip,
  IconButton,
  Input,
  MicButton,
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
} from "./chat.styled";
import ActionTimeline from "./chat/ActionTimeline";
import { formatWorkDuration } from "./chat/tools";
import type { AgentThread, AgentTurn } from "./chat/thread";
import { ClearIcon, CloseIcon, MicIcon, SendIcon, StopIcon } from "./icons";
import StreamMarkdown from "./markdown/StreamMarkdown";
import DataPanels from "./panels/DataPanels";
import ExpandedPanels from "./panels/ExpandedPanels";
import { PHASE_LABELS, voiceIsLive, type AgentPhase } from "./phase";

/** Route limit (app/api/agent/stream: MAX_QUESTION_CHARS). */
const MAX_QUESTION_CHARS = 4_000;
/** Distance from the bottom that still counts as "following" the stream. */
const STICK_PX = 48;

export type ChatVoice = Partial<VoiceState>;

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

function VoiceStrip({ voice }: { voice: ChatVoice | undefined }) {
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

export type ChatPaneProps = {
  thread: AgentThread;
  asking: boolean;
  phase: AgentPhase;
  voice: ChatVoice | undefined;
  selected: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** First visit: show the hint line with example questions above the composer. */
  showHint: boolean;
  onDismissHint: () => void;
  onSend: (question: string) => Promise<boolean>;
  onStop: () => void;
  onClear: () => void;
  onCite: (id: string) => void;
  onToggleVoice: () => void;
  /** Focus in the composer (phones grow the sheet so the thread shows). */
  onComposerFocus?: () => void;
  /** Collapsed phone sheet: the composer bar alone. */
  compact?: boolean;
};

/** The Agent tab: status line, transcript with data panels and citations, the first-visit hint, and the composer. */
export default function ChatPane({
  thread,
  asking,
  phase,
  voice,
  selected,
  inputRef,
  showHint,
  onDismissHint,
  onSend,
  onStop,
  onClear,
  onCite,
  onToggleVoice,
  onComposerFocus,
  compact = false,
}: ChatPaneProps) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const closeExpanded = useCallback(() => setExpanded(null), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const live = voiceIsLive(voice);
  const pulsing = phase === "listening" || phase === "speaking";

  // Follow the stream while the reader is at the bottom; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread.messages]);

  const ask = async (question: string) => {
    if (!question || asking) return;
    stick.current = true;
    onDismissHint();
    const sent = await onSend(question);
    if (!sent) setDraft(question);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const question = draft.trim();
    if (!question || asking) return;
    setDraft("");
    await ask(question);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const composer = (
    <Composer onSubmit={submit} data-composer="">
      <Input
        ref={inputRef}
        rows={1}
        value={draft}
        maxLength={MAX_QUESTION_CHARS}
        placeholder="Ask the field agent…"
        aria-label="Question"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onComposerFocus}
      />
      <MicButton
        type="button"
        $live={live}
        $pulse={pulsing}
        aria-label={live ? "Stop voice" : "Start voice"}
        aria-pressed={live}
        title={live ? "Stop voice" : "Talk to the agent"}
        data-voice-phase={phase}
        onClick={onToggleVoice}
      >
        <MicIcon />
      </MicButton>
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
  );

  // One slot for the thread, one for the composer: collapsing the phone sheet never remounts the composer, so
  // it keeps focus and the draft.
  return (
    <>
      {compact ? null : (
        <>
      <Header data-chat-header="">
        <Title>
          <Status aria-live="polite" data-agent-phase={phase}>
            {PHASE_LABELS[phase]}
          </Status>
        </Title>
        <IconButton type="button" aria-label="Clear conversation" title="Clear conversation" disabled={asking || thread.messages.length === 0} onClick={onClear}>
          <ClearIcon />
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
          // The first-visit hint says the same thing with examples; the empty line is for later visits.
          showHint ? null : <Empty>Ask about sightings, hotspots, conditions or alerts in view. Answers cite their evidence and fly the globe.</Empty>
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
      {showHint ? (
        <Hint data-chat-hint="" aria-label="Example questions">
          <p>
            <span>{FIRST_VISIT_HINT}</span>
            <IconButton type="button" aria-label="Dismiss hint" onClick={onDismissHint}>
              <CloseIcon />
            </IconButton>
          </p>
          {EXAMPLE_QUESTIONS.map((q) => (
            <HintChip key={q} type="button" data-example-question="" disabled={asking} onClick={() => void ask(q)}>
              {q}
            </HintChip>
          ))}
        </Hint>
      ) : null}
        </>
      )}
      {composer}
    </>
  );
}
