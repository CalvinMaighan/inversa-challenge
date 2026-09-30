"use client";

import { useCallback, useRef } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { AGENT_CARD, SELECTION, VOICE } from "client/state";
import type { AgentCardState } from "client/state/agent";
import type { SelectionState } from "client/state/selection";
import { startVoice, stopVoice } from "client/voice/voice-runtime";

import AgentCard, { type CardVoice } from "./AgentCard";
import { openEvidence } from "./chat/effects";
import { isWorking } from "./chat/thread";
import { useAgentChat } from "./chat/useAgentChat";
import { MicIcon } from "./icons";
import { cardTargetRect, measureElementRect, viewportSize, type ElementRect } from "./morph/geometry";
import RectMorphPortal from "./morph/RectMorphPortal";
import type { CloseReason } from "./morph/useRectMorph";
import { Dot, MicButton, OrbButton, OrbWrap, Spinner } from "./orb.styled";
import { ORB_LABELS, orbPhase, voiceIsLive } from "./orb-phase";

/** Holding the orb this long toggles voice instead of opening the card. */
const LONG_PRESS_MS = 450;

const computeTarget = (source: ElementRect) => cardTargetRect(source, viewportSize());

/**
 * Agent orb (PRD §3 flow 1, §12): a presence dot in the bottom-right corner that pulses while voice listens
 * or speaks and spins while the agent works. Click (or Enter) morphs it into the chat card; a long press or
 * the small mic button toggles voice.
 */
export default function AgentOrb() {
  const [card] = useActiveState<AgentCardState>(AGENT_CARD);
  const [voice] = useActiveState<CardVoice>(VOICE);
  const [selected] = useActiveState<SelectionState, string | null>(SELECTION, (s) => s?.evidenceId ?? null);
  const chat = useAgentChat();
  const orbRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

  const open = card?.open === true;
  const phase = orbPhase(voice, isWorking(chat.thread));
  const live = voiceIsLive(voice);

  const toggleVoice = useCallback(() => {
    if (voiceIsLive(voice)) stopVoice();
    else void startVoice();
  }, [voice]);

  const openCard = () => {
    const el = orbRef.current;
    const rect = el ? measureElementRect(el) : null;
    set<AgentCardState>(AGENT_CARD, {
      open: true,
      anchor: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null,
    });
  };

  const onClose = (reason: CloseReason) => {
    set<AgentCardState>(AGENT_CARD, (prev) => ({ ...AGENT_CARD.defaults, ...prev, open: false }));
    if (reason === "keyboard") orbRef.current?.focus();
  };

  const clearPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  return (
    <OrbWrap data-agent-orb="" data-phase={phase}>
      <OrbButton
        ref={orbRef}
        type="button"
        aria-label={`Open agent chat (${ORB_LABELS[phase].toLowerCase()})`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Click to chat · hold to talk"
        tabIndex={open ? -1 : 0}
        data-open={open ? "" : undefined}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          longPressed.current = false;
          clearPress();
          pressTimer.current = window.setTimeout(() => {
            pressTimer.current = null;
            longPressed.current = true;
            toggleVoice();
          }, LONG_PRESS_MS);
        }}
        onPointerUp={clearPress}
        onPointerLeave={clearPress}
        onPointerCancel={clearPress}
        onContextMenu={(event) => event.preventDefault()}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          openCard();
        }}
      >
        <Dot $phase={phase} aria-hidden />
        {phase === "thinking" ? <Spinner aria-hidden /> : null}
      </OrbButton>
      <MicButton
        type="button"
        aria-label={live ? "Stop voice" : "Start voice"}
        aria-pressed={live}
        tabIndex={open ? -1 : 0}
        data-open={open ? "" : undefined}
        onClick={toggleVoice}
      >
        <MicIcon />
      </MicButton>
      <RectMorphPortal
        open={open}
        sourceRef={orbRef}
        computeTarget={computeTarget}
        label="Agent chat"
        onClose={onClose}
        onOpened={() => inputRef.current?.focus()}
      >
        {({ requestClose }) => (
          <AgentCard
            thread={chat.thread}
            asking={chat.asking}
            phase={phase}
            voice={voice}
            selected={selected ?? null}
            inputRef={inputRef}
            onSend={chat.send}
            onStop={chat.stop}
            onClear={chat.clear}
            onCite={openEvidence}
            onToggleVoice={toggleVoice}
            onClose={() => requestClose("keyboard")}
          />
        )}
      </RectMorphPortal>
    </OrbWrap>
  );
}
