/**
 * Every API key the app uses (docs/GODS_EYE.md GC3 and "Developer panel spec"). One row per provider; the
 * Developer panel draws one row per entry, `GET /api/dev/keys` reports the server rows, `scripts/dev.ts` loads
 * `data/local-keys.env` with the dotenv helpers at the bottom.
 *
 * Browser keys run in the page (restrict them at the provider): localStorage `inversa:keys:<id>` first, then the
 * build-time `NEXT_PUBLIC_*` value. Server keys never reach the browser: only whether they are set.
 */

export type KeyScope = "browser" | "server";
/** `headline` unlocks a headline feature (red dot); `optional` adds a feed (yellow dot). */
export type KeyPriority = "headline" | "optional";

export type KeyEntry = {
  id: string;
  label: string;
  scope: KeyScope;
  priority: KeyPriority;
  /** Environment variables the provider needs, in the order the panel asks for them. */
  vars: readonly string[];
  /** One plain line on what the key unlocks. */
  purpose: string;
  /** Where to create a key. */
  getUrl: string;
  /** Where to manage (restrict, rotate, see usage of) a key that is set. */
  manageUrl: string;
  /** What the app does without it. */
  fallback: string;
};

export const KEY_REGISTRY = [
  {
    id: "google-maps",
    label: "Google Maps",
    scope: "browser",
    priority: "headline",
    vars: ["NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"],
    purpose: "The photorealistic 3D planet",
    getUrl: "https://developers.google.com/maps/documentation/tile/get-api-key",
    manageUrl: "https://console.cloud.google.com/google/maps-apis/credentials",
    fallback: "Google 3D through Cesium ion when that token is set, otherwise keyless Esri imagery",
  },
  {
    id: "cesium-ion",
    label: "Cesium ion",
    scope: "browser",
    priority: "optional",
    vars: ["NEXT_PUBLIC_CESIUM_ION_TOKEN"],
    purpose: "Real terrain and sharper aerial imagery",
    getUrl: "https://ion.cesium.com/tokens",
    manageUrl: "https://ion.cesium.com/tokens",
    fallback: "keyless Esri imagery on a smooth globe",
  },
  {
    id: "aisstream",
    label: "AISStream",
    scope: "server",
    priority: "optional",
    vars: ["AISSTREAM_API_KEY"],
    purpose: "Live ships, worldwide",
    getUrl: "https://aisstream.io/apikeys",
    manageUrl: "https://aisstream.io/apikeys",
    fallback: "the ships layer replays what is already stored",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    scope: "server",
    priority: "headline",
    vars: ["OPENROUTER_API_KEY"],
    purpose: "Ask the map questions in plain words",
    getUrl: "https://openrouter.ai/settings/keys",
    manageUrl: "https://openrouter.ai/settings/keys",
    fallback: "the agent answers 503 agent unavailable",
  },
  {
    id: "xai",
    label: "xAI voice",
    scope: "server",
    priority: "optional",
    vars: ["XAI_API_KEY"],
    purpose: "Talk to the globe",
    getUrl: "https://console.x.ai/",
    manageUrl: "https://console.x.ai/",
    fallback: "voice is off; text chat still works",
  },
  {
    id: "fastino",
    label: "Fastino GLiDE",
    scope: "server",
    priority: "optional",
    vars: ["FASTINO_API_KEY"],
    purpose: "Fast routing of every question before the big model",
    getUrl: "https://docs.fastino.ai/quickstart",
    manageUrl: "https://docs.fastino.ai/quickstart",
    fallback: "every question goes straight to the agent, as before",
  },
] as const satisfies readonly KeyEntry[];

export type KeyId = (typeof KEY_REGISTRY)[number]["id"];
export type BrowserKeyId = Extract<(typeof KEY_REGISTRY)[number], { scope: "browser" }>["id"];

/** Every variable a server row names: the only names `POST /api/dev/keys` accepts. */
export const SERVER_KEY_VARS: readonly string[] = KEY_REGISTRY.filter((k) => k.scope === "server").flatMap((k) => k.vars);

export function keyEntry(id: string): KeyEntry | undefined {
  return KEY_REGISTRY.find((k) => k.id === id);
}

// ---- browser keys --------------------------------------------------------------------------------------

export const BROWSER_KEY_PREFIX = "inversa:keys:";
export const browserKeyStorageKey = (id: BrowserKeyId) => `${BROWSER_KEY_PREFIX}${id}`;

export type KeyStore = Pick<Storage, "getItem">;
/** Build-time values per browser key (`client/keys.ts` reads the `NEXT_PUBLIC_*` env). */
export type BuildKeys = Partial<Record<BrowserKeyId, string | undefined>>;

export type BrowserKeySource = "local" | "build" | null;

/** A browser key and where it came from: localStorage first, then the build env; blank counts as unset. */
export function resolveBrowserKey(id: BrowserKeyId, store: KeyStore | null, build: BuildKeys): { value: string | null; source: BrowserKeySource } {
  let stored: string | null = null;
  try {
    stored = store?.getItem(browserKeyStorageKey(id))?.trim() || null;
  } catch {
    // Private mode or blocked storage: fall through to the build value.
  }
  if (stored) return { value: stored, source: "local" };
  const built = build[id]?.trim();
  return built ? { value: built, source: "build" } : { value: null, source: null };
}

// ---- server key status (GET /api/dev/keys) --------------------------------------------------------------

/**
 * `external`: set through the shell or Doppler (shown, never touched). `local`: loaded from data/local-keys.env.
 * `pending`: saved to that file, not yet in the running server (the dev supervisor restarts it).
 */
export type ServerKeySource = "external" | "local" | "pending" | null;

export type ServerVarStatus = { name: string; set: boolean; source: ServerKeySource };

/** One server row of `GET /api/dev/keys`: booleans and names only, never a value. */
export type ServerKeyStatus = {
  id: string;
  set: boolean;
  source: ServerKeySource;
  vars: ServerVarStatus[];
  /** This server accepts `POST /api/dev/keys` for it (local development on loopback). */
  writable: boolean;
};

// ---- dotenv (data/local-keys.env) ----------------------------------------------------------------------

/** Variable names this file may hold: upper-case shell names. */
export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
export const MAX_KEY_LENGTH = 4096;

/** A pasted value is acceptable: non-empty, bounded, printable, no whitespace inside (no line or quote tricks). */
export function validKeyValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_KEY_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

/** `NAME=value` lines; blank lines, `#` comments and malformed lines are skipped. Values are taken verbatim. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (ENV_NAME.test(name) && value) out[name] = value;
  }
  return out;
}

export const LOCAL_KEYS_HEADER = "# Written by the Developer panel (POST /api/dev/keys) for local development only. Never commit.";

/** The file body for a set of values, one `NAME=value` per line, names sorted. */
export function serializeEnvFile(values: Record<string, string>): string {
  const lines = Object.keys(values)
    .sort()
    .map((name) => `${name}=${values[name]}`);
  return `${LOCAL_KEYS_HEADER}\n${lines.join("\n")}\n`;
}
