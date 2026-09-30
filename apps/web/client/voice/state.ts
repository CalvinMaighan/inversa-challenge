import { getStateInstance, init, key, registeredState } from "@calvinjs/active-state";

import type { VoiceInputMode, VoiceState, VoiceTaskSnapshot } from "shared/voice/protocol";
import type { LAYER_IDS, SPECIES_IDS } from "shared/voice/ui-tools";

/**
 * Active-state keys voice reads and writes. `client/state` (T3's catalog) does not exist on
 * this branch yet, so they are defined here per the fallback rule; the driver reconciles them
 * into the catalog (same ids and default shapes) and re-exports from there.
 */

export type LayerId = (typeof LAYER_IDS)[number];
export type SpeciesId = (typeof SPECIES_IDS)[number];

export type VoiceStatus = "off" | "connecting" | "live" | "error";

/** Voice session, readable anywhere (orb, card, HUD). */
export const VOICE = key("VOICE", {
  status: "off" as VoiceStatus,
  sessionId: null as string | null,
  /** Provider-side turn state while live. */
  state: "idle" as VoiceState,
  error: null as string | null,
  /** Realtime tool Grok is running right now, if any. */
  activeTool: null as string | null,
  inputMode: "talk" as VoiceInputMode,
  /** Live partial transcripts for the current user turn and assistant response. */
  userText: "",
  assistantText: "",
  /** Background analysis spawned from this session, oldest first. */
  tasks: [] as VoiceTaskSnapshot[],
  /** Last UI command applied, e.g. "fly_to", for the orb's receipt line. */
  lastCommand: null as string | null,
});

export type VoiceKeyState = typeof VOICE.defaults;

/** Camera target. `seq` bumps on every fly command so the globe re-flies to the same spot. */
export const VIEW = key("VIEW", {
  lat: 25.9,
  lon: -81.5,
  altitudeM: 450_000,
  place: null as string | null,
  seq: 0,
});

/** Timeline. `at` null means live (now). `speed` is frames per second; one frame is 15 minutes. */
export const TIME = key("TIME", {
  at: null as string | null,
  playing: false,
  speed: 8,
  from: null as string | null,
  to: null as string | null,
});

/** Layer visibility plus an optional species filter per layer. */
export const LAYERS = key("LAYERS", {
  visible: {
    sightings: true,
    hotspots: true,
    lst: false,
    sst: false,
    stations: true,
    alerts: true,
    missions: true,
    peers: true,
  } as Record<LayerId, boolean>,
  species: {} as Partial<Record<LayerId, SpeciesId>>,
});

/** Selected evidence id (`<kind>:<key>`, C14) and whether the evidence drawer is open. */
export const SELECTION = key("SELECTION", {
  evidenceId: null as string | null,
  drawerOpen: false,
});

export const VOICE_KEYS = [VOICE, VIEW, TIME, LAYERS, SELECTION] as const;

/**
 * Boot the store if the app shell has not (tests, or voice started before the shell mounted).
 * `init` is idempotent, so a later `<ActiveState init={state}>` is a no-op either way.
 */
export function ensureVoiceState(): void {
  try {
    getStateInstance();
  } catch {
    init(registeredState());
  }
}
