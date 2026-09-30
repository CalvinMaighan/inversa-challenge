"use client";

import { useCallback, useEffect, useRef } from "react";
import { get, set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { AGENT_CHAT, LAYERS, SELECTION, TIME, VIEW } from "client/state";
import { onTaskEvent } from "client/voice/voice-runtime";
import type { AgentStreamEvent } from "shared/agent/events";

import { applyAgentSideEffects } from "./effects";
import { AGENT_STREAM_URL, streamAgentTurn } from "./ndjson";
import { buildAgentRequest, type ViewSnapshot } from "./request";
import { asThread, isAsking, reduceThread, voiceTurnId, type AgentThread, type ThreadAction } from "./thread";

function dispatch(action: ThreadAction): void {
  set<AgentThread>(AGENT_CHAT, (prev) => reduceThread(asThread(prev), action));
}

function readSnapshot(): ViewSnapshot {
  return {
    view: get<ViewSnapshot["view"]>(VIEW),
    time: get<ViewSnapshot["time"]>(TIME),
    layers: get<ViewSnapshot["layers"]>(LAYERS),
    selection: get<ViewSnapshot["selection"]>(SELECTION),
  };
}

type Pending = { id: string; voiceTaskId?: string; events: AgentStreamEvent[] };

/**
 * The card's chat: posts questions to the agent route, and folds streamed events (typed turns and
 * voice-spawned tasks alike) into AGENT_CHAT. Deltas arrive many times a second, so they are batched to one
 * store write per animation frame; side effects (camera, timeline) run as each event lands.
 */
export function useAgentChat(endpoint: string = AGENT_STREAM_URL) {
  const [value] = useActiveState<AgentThread>(AGENT_CHAT);
  const thread = asThread(value);
  const abortRef = useRef<AbortController | null>(null);
  const pending = useRef<Pending[]>([]);
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    const batches = pending.current;
    if (!batches.length) return;
    pending.current = [];
    const nowMs = Date.now();
    for (const batch of batches) dispatch({ type: "events", id: batch.id, events: batch.events, nowMs, voiceTaskId: batch.voiceTaskId });
  }, []);

  const enqueue = useCallback(
    (id: string, event: AgentStreamEvent, voiceTaskId?: string) => {
      applyAgentSideEffects(event);
      const last = pending.current[pending.current.length - 1];
      if (last && last.id === id) last.events.push(event);
      else pending.current.push({ id, voiceTaskId, events: [event] });
      frame.current ??= requestAnimationFrame(flush);
    },
    [flush],
  );

  // Voice-spawned tasks stream into the same thread, whether or not the card is open.
  useEffect(() => onTaskEvent((taskId, event) => enqueue(voiceTurnId(taskId), event, taskId)), [enqueue]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const send = useCallback(
    async (question: string): Promise<boolean> => {
      const text = question.trim();
      if (!text || abortRef.current || isAsking(asThread(get<AgentThread>(AGENT_CHAT)))) return false;
      let sessionId = asThread(get<AgentThread>(AGENT_CHAT)).sessionId;
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        dispatch({ type: "session", sessionId });
      }
      const userId = crypto.randomUUID();
      const assistantId = crypto.randomUUID();
      const nowMs = Date.now();
      dispatch({ type: "user", id: userId, text, nowMs });
      dispatch({ type: "assistant", id: assistantId, nowMs });

      const abort = new AbortController();
      abortRef.current = abort;
      const result = await streamAgentTurn({
        url: endpoint,
        request: buildAgentRequest(sessionId, text, readSnapshot(), nowMs),
        signal: abort.signal,
        onEvent: (event) => enqueue(assistantId, event),
      });
      flush();
      if (abortRef.current === abort) abortRef.current = null;

      const end = Date.now();
      if (!result.ok) {
        dispatch(result.aborted ? { type: "stop", id: assistantId, nowMs: end } : { type: "fail", id: assistantId, message: result.error, nowMs: end });
      } else {
        // The route always ends with `done`; a stream cut short must not spin forever.
        const turn = asThread(get<AgentThread>(AGENT_CHAT)).messages.find((m) => m.id === assistantId);
        if (turn?.status === "streaming") dispatch({ type: "fail", id: assistantId, message: "The answer stream ended early.", nowMs: end });
      }
      return true;
    },
    [endpoint, enqueue, flush],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    if (abortRef.current) return;
    dispatch({ type: "clear" });
  }, []);

  return { thread, asking: isAsking(thread), send, stop, clear };
}
