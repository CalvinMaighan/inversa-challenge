/**
 * `GET/POST /api/dev/keys` (docs/GODS_EYE.md GC3, "Developer panel spec").
 *
 * GET answers, for every server row of `KEY_REGISTRY`, whether each variable is set and where it came from. It
 * never returns a value. POST takes pasted server keys and merges them into `<INVERSA_DATA_DIR>/local-keys.env`
 * (mode 0600, created when absent); `scripts/dev.ts` watches that file and restarts the API and web processes it
 * started. POST is for local development only: `next dev` (NODE_ENV development) and a loopback request, else 403
 * and the panel shows the `doppler secrets set` command instead. A variable already set through the shell or
 * Doppler wins: it is reported `external` and never overwritten.
 *
 * Loopback check: the Host header, Next's `x-forwarded-for` (the socket address, unless a client sent its own), and
 * for browsers `Origin` and `Sec-Fetch-Site`. Together with the JSON content type (a cross-site form or fetch
 * cannot send it without a preflight nobody answers) this stops cross-site requests and DNS rebinding. `next dev`
 * listens on every interface, so a peer on the LAN that forges Host and X-Forwarded-For could still post; it can
 * add a key but never read one, and the same peer can already use the whole dev server.
 *
 * No value is logged: the only log line names the variables saved.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  KEY_REGISTRY,
  parseEnvFile,
  SERVER_KEY_VARS,
  serializeEnvFile,
  validKeyValue,
  type ServerKeySource,
  type ServerKeyStatus,
  type ServerVarStatus,
} from "shared/keys";

export type DevEnv = Record<string, string | undefined>;

export const LOCAL_KEYS_FILE = "local-keys.env";
/** A paste of every server key fits in far less. */
const MAX_BODY_BYTES = 64 * 1024;

export function localKeysPath(env: DevEnv): string {
  const dir = env.INVERSA_DATA_DIR?.trim() || path.resolve(process.cwd(), "../../data");
  return path.join(dir, LOCAL_KEYS_FILE);
}

/** Names (never values) held by the local file; empty when it is missing or unreadable. */
function fileNames(file: string): Set<string> {
  try {
    return new Set(Object.keys(parseEnvFile(readFileSync(file, "utf8"))));
  } catch {
    return new Set();
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function loopbackAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return a === "::1" || a === "localhost" || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(a);
}

/** The request came from this machine, from a same-origin page or a non-browser client (see the module note). */
export function isLoopbackRequest(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(hostname)) return false;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded && !forwarded.split(",").every(loopbackAddress)) return false;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

/** POST is allowed: `next dev` and a loopback request. */
export function writable(req: Request, env: DevEnv): boolean {
  return env.NODE_ENV === "development" && isLoopbackRequest(req);
}

/** Names that `scripts/dev.ts` loaded from the local file (it passes the names, never the values). */
function localNames(env: DevEnv): Set<string> {
  return new Set((env.INVERSA_LOCAL_KEYS ?? "").split(",").filter(Boolean));
}

function varSource(name: string, env: DevEnv, local: Set<string>, inFile: Set<string>): ServerKeySource {
  if (env[name]?.trim()) return local.has(name) ? "local" : "external";
  return inFile.has(name) ? "pending" : null;
}

export function serverKeyStatus(env: DevEnv, canWrite: boolean): ServerKeyStatus[] {
  const local = localNames(env);
  const inFile = fileNames(localKeysPath(env));
  return KEY_REGISTRY.filter((k) => k.scope === "server").map((k) => {
    const vars: ServerVarStatus[] = k.vars.map((name) => {
      const source = varSource(name, env, local, inFile);
      return { name, set: source === "external" || source === "local", source };
    });
    const set = vars.every((v) => v.set);
    const source: ServerKeySource = set
      ? vars.every((v) => v.source === "external")
        ? "external"
        : "local"
      : vars.some((v) => v.source === "pending")
        ? "pending"
        : null;
    return { id: k.id, set, source, vars, writable: canWrite };
  });
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function handleGet(req: Request, env: DevEnv): Response {
  return json(serverKeyStatus(env, writable(req, env)));
}

export type SaveResult = { saved: string[]; external: string[]; restart: "supervisor" | "manual"; file: string };

export async function handlePost(req: Request, env: DevEnv): Promise<Response> {
  if (!writable(req, env)) {
    return json({ error: "local development only: set server keys with `doppler secrets set NAME` instead" }, 403);
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "send application/json" }, 415);
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
  const values = (body as { values?: unknown } | null)?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return json({ error: "expected { values: { NAME: value } }" }, 400);
  const entries = Object.entries(values as Record<string, unknown>);
  if (entries.length === 0) return json({ error: "no keys given" }, 400);
  for (const [name, value] of entries) {
    // Names are checked against the registry before they are echoed; values are never echoed.
    if (!SERVER_KEY_VARS.includes(name)) return json({ error: "unknown key name: only the server keys of the Developer panel are accepted" }, 400);
    if (!validKeyValue(value)) return json({ error: `${name}: paste the key as one line without spaces (up to 4096 characters)` }, 400);
  }

  const local = localNames(env);
  const external = entries.filter(([name]) => env[name]?.trim() && !local.has(name)).map(([name]) => name);
  const accepted = entries.filter(([name]) => !external.includes(name)) as [string, string][];

  const file = localKeysPath(env);
  if (accepted.length > 0) {
    let current: Record<string, string> = {};
    try {
      current = parseEnvFile(readFileSync(file, "utf8"));
    } catch {
      // Absent: created below.
    }
    for (const [name, value] of accepted) current[name] = value;
    mkdirSync(path.dirname(file), { recursive: true });
    // Written beside the target with 0600 from the start, then renamed over it: never readable by others, never half written.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, serializeEnvFile(current), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    console.info(`[dev keys] saved ${accepted.map(([n]) => n).join(", ")} to ${file}`);
  }
  const result: SaveResult = {
    saved: accepted.map(([n]) => n),
    external,
    restart: env.INVERSA_DEV_SUPERVISOR === "1" ? "supervisor" : "manual",
    file,
  };
  return json(result);
}
