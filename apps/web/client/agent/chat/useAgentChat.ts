"use client";

import { useCallback, useEffect, useRef } from "react";
import { get, uuid } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { AGENT_CHAT, LAYERS, SELECTION, TIME, VIEW } from "client/state";
import { activeAppId } from "client/state/app";
import { onTaskEvent } from "client/voice/voice-runtime";
import type { AgentStreamEvent } from "shared/agent/events";

import { clearHighlight, showTurn } from "../panels/effects";
import { clearPanels, recordToolEnd } from "../panels/store";
import { applyAgentSideEffects, onReask } from "./effects";
import { AGENT_STREAM_URL, streamAgentTurn } from "./ndjson";
import { buildAgentRequest, type ViewSnapshot } from "./request";
import { dispatchThread } from "./store";
import { asThread, isAsking, voiceTurnId, type AgentThread } from "./thread";

const dispatch = dispatchThread;

/** Ask the server which questions to offer next (Fastino GLiDE); nothing is shown when it has no suggestion. */
async function loadFollowUps(id: string, question: string, answer: string): Promise<void> {
  if (!answer.trim()) return;
  const asked = asThread(get<AgentThread>(AGENT_CHAT)).messages.filter((m) => m.role === "user").map((m) => m.text);
  try {
    const res = await fetch("/api/agent/followups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: activeAppId(), question, answer, asked }) });
    if (!res.ok) return;
    const { items } = (await res.json()) as { items?: string[] };
    if (Array.isArray(items) && items.length > 0) dispatch({ type: "followups", id, items: items.slice(0, 3) });
  } catch {
    // Suggestions are a nicety; the answer stands without them.
  }
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
      recordToolEnd(id, event);
      // A finished answer brackets its results on the globe and frames them.
      if (event.type === "done") {
        showTurn(id);
        // The next questions come once the answer is whole (a stopped or failed turn gets none).
        if (event.content) {
          const q = [...asThread(get<AgentThread>(AGENT_CHAT)).messages].reverse().find((m) => m.role === "user")?.text ?? "";
          void loadFollowUps(id, q, event.content);
        }
      }
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
    async (question: string, opts: { silent?: boolean } = {}): Promise<boolean> => {
      const text = question.trim();
      if (!text || abortRef.current || isAsking(asThread(get<AgentThread>(AGENT_CHAT)))) return false;
      let sessionId = asThread(get<AgentThread>(AGENT_CHAT)).sessionId;
      if (!sessionId) {
        sessionId = uuid();
        dispatch({ type: "session", sessionId });
      }
      const userId = uuid();
      const assistantId = uuid();
      const nowMs = Date.now();
      // A silent turn answers a question already on the thread (asked again in the app the agent just switched to).
      if (!opts.silent) dispatch({ type: "user", id: userId, text, nowMs });
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

  useEffect(() => {
    onReask((question) => void send(question, { silent: true }));
    return () => onReask(null);
  }, [send]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    if (abortRef.current) return;
    dispatch({ type: "clear" });
    clearPanels();
    clearHighlight();
  }, []);

  return { thread, asking: isAsking(thread), send, stop, clear };
}
