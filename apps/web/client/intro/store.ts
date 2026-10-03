"use client";

import { useSyncExternalStore } from "react";
import { get, set } from "@calvinjs/active-state";

import { switchApp } from "client/hud/appselect/switch";
import { parkFishAtStart, startFishPlay } from "client/carp/fish";
import { activeAppId } from "client/state/app";
import { TIME, type TimeState } from "client/state/time";
import { VIEW, type ViewState } from "client/state/view";
import { VOICE, type VoiceState } from "client/state/voice";
import { startVoice } from "client/voice/voice-runtime";
import { getApp, type AppId } from "shared/apps";

import { INTRO_FLAG } from "./constants";
import { entryView, INTRO_ATTR, LEAVE_MS, OVERVIEW_ALTITUDE_M, overviewView, progressOf, type IntroPhase } from "./model";
import { startPreload, warmFiner } from "./preload";

/**
 * The gate's state: which step it is on, the species picked, whether the microphone request is in flight, and how far
 * the background preload has got. A plain store (one writer, this module); the app's own state lives in the catalog.
 */
/** The timeline's playback speed when the gate presses play for the user (8×, one of its speed choices). */
const PLAY_SPEED = 8;

export type IntroState = {
  phase: IntroPhase;
  app: AppId | null;
  /** The microphone request is in flight. */
  busy: boolean;
  /** Why the microphone did not start, shown under the button. */
  note: string | null;
  /** Background preload, 0 to 1. */
  progress: number;
};

const first: IntroState = { phase: "pick", app: null, busy: false, note: null, progress: 0 };
let state: IntroState = first;
const listeners = new Set<() => void>();

function patch(next: Partial<IntroState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

const subscribeIntro = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useIntro(): IntroState {
  return useSyncExternalStore(subscribeIntro, () => state, () => first);
}

export function introState(): IntroState {
  return state;
}

const root = () => (typeof document === "undefined" ? null : document.documentElement);

/** Called once after hydration: skip the gate when the page did not ask for it, else park the camera high and start loading. */
export function introInit(): void {
  if (state.phase !== "pick" || state.app !== null) return;
  const el = root();
  const wanted = Boolean(el?.hasAttribute(INTRO_ATTR) || (globalThis as Record<string, unknown>)[INTRO_FLAG] === true);
  if (!wanted) {
    patch({ phase: "done" });
    return;
  }
  // React removed the attribute while hydrating <html>; the chrome stays hidden from this commit on.
  el?.setAttribute(INTRO_ATTR, "");
  // A refresh starts fresh: the last visit's camera in the hash must not pull the globe down from the overview.
  if (typeof window !== "undefined" && window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  set<ViewState>(VIEW, (prev = VIEW.defaults) => overviewView(prev));
  parkTimelines();
  startPreload(activeAppId(), (done, total) => patch({ progress: progressOf(done, total) }));
}

/** Both timelines sit idle at their first day while the gate is up (species apps: TIME; carp: its own cursor). */
function parkTimelines(): void {
  set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, at: prev.from, playing: false }));
  parkFishAtStart();
}

/** The play button, pressed for the user at 8x: the timeline replays from its start and loads the data in as it goes. */
function playTimeline(id: AppId): void {
  if (getApp(id).kind === "conditions") {
    startFishPlay(PLAY_SPEED);
    return;
  }
  set<TimeState>(TIME, (prev = TIME.defaults) => ({ ...prev, speed: PLAY_SPEED, playing: true, at: prev.from }));
}

/** The first click: switch to the species (its workers start loading at once) and keep the camera high. */
export function choose(id: AppId): void {
  if (state.phase !== "pick" && state.phase !== "enter") return;
  if (state.busy) return;
  if (activeAppId() !== id) switchApp(id);
  // The switch put the camera on the app's own area; the gate keeps the whole globe in view whichever species is chosen.
  set<ViewState>(VIEW, (prev = VIEW.defaults) => (prev.altitudeM >= OVERVIEW_ALTITUDE_M * 0.9 ? prev : overviewView(prev)));
  parkTimelines();
  warmFiner(id);
  patch({ phase: "enter", app: id, note: null });
}

/** The gate blurs out, the chrome fades in, the camera comes down to 5,000 km over the species' area. */
function reveal(id: AppId): void {
  patch({ phase: "leaving", busy: false, note: null });
  root()?.removeAttribute(INTRO_ATTR);
  set<ViewState>(VIEW, (prev = VIEW.defaults) => entryView(id, prev));
  playTimeline(id);
  setTimeout(() => patch({ phase: "done" }), LEAVE_MS);
}

/**
 * The second click. With voice, it is the user gesture that lets the browser ask for the microphone; the gate opens once
 * the session is up (the guide then welcomes them). If the microphone is refused the gate stays, says why, and offers
 * `enter(false)`.
 */
export async function enter(withVoice: boolean): Promise<void> {
  const id = state.app;
  if (state.phase !== "enter" || !id || state.busy) return;
  if (!withVoice) {
    reveal(id);
    return;
  }
  patch({ busy: true, note: null });
  await startVoice({ welcome: true });
  const voice = get<VoiceState>(VOICE);
  if (!voice || voice.status === "error" || voice.status === "off") {
    patch({ busy: false, note: voice?.error ?? "The microphone did not start." });
    return;
  }
  reveal(id);
}

/** Test hook. */
export function resetIntro(): void {
  state = first;
  for (const l of listeners) l();
}
