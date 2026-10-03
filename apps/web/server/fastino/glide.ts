/**
 * Fastino GLiDE (Generalized Lightweight Decision Engine): a decision model, not a text generator. It reads a state and
 * answers typed questions with probabilities: `noul` (yes/no), `choice` (one of up to 255 options) and `score` (an ordered
 * scale). POST https://api.fastino.ai/v1/systemone with the key from FASTINO_API_KEY (docs.fastino.ai, "GLiDE inference").
 * Measured here: 0.5 to 0.8 s for two questions, which is why the app uses it to route and gate before the large model runs.
 *
 * The key stays on the server and is never logged. Without a key, on a timeout or after repeated failures every caller gets
 * `null` and carries on with its old behaviour: GLiDE only ever adds a decision, never becomes a dependency.
 */

const DEFAULT_ORIGIN = "https://api.fastino.ai";
const MODEL = "fastino/GLiDE";
/** A decision that takes longer than this is not worth waiting for. */
const DEFAULT_TIMEOUT_MS = 4_000;
/** Statuses Fastino documents as retryable (425 and 503 with bounded backoff, 429 honouring Retry-After). */
const RETRYABLE = new Set([425, 429, 503]);
/** After this many failures in a row the API is skipped for COOL_DOWN_MS, so an outage never slows a turn. */
const BREAKER_FAILURES = 3;
const COOL_DOWN_MS = 60_000;

export type NoulQuestion = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type GlideQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number; confidence: number };
export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = { type: "score"; score: number; expected_level: number; confidence: number; probabilities: Record<string, number> };
export type GlideAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type GlideResult<Q extends Record<string, GlideQuestion>> = {
  answers: { [K in keyof Q]: Q[K] extends NoulQuestion ? NoulAnswer : Q[K] extends ChoiceQuestion ? ChoiceAnswer : ScoreAnswer };
  latencyMs: number;
  inputTokens: number;
};

/** What went wrong, without the key or the state. */
export class GlideError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GlideError";
  }
}

export type GlideOptions = {
  apiKey?: string;
  origin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Waits between retries (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
};

let failures = 0;
let coolUntil = 0;

/** Test hook: forget earlier failures. */
export function resetGlideBreaker(): void {
  failures = 0;
  coolUntil = 0;
}

export const glideKey = (apiKey?: string): string | null => (apiKey ?? process.env.FASTINO_API_KEY)?.trim() || null;

/** Whether a decision can be asked for right now (a key is set and the API is not cooling down). */
export function glideAvailable(apiKey?: string, now = Date.now()): boolean {
  return glideKey(apiKey) !== null && now >= coolUntil;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask GLiDE the questions about `state`. Throws GlideError on a bad answer; see `decide` for the forgiving form.
 */
export async function glide<Q extends Record<string, GlideQuestion>>(state: string | object | unknown[], questions: Q, options: GlideOptions = {}): Promise<GlideResult<Q>> {
  const key = glideKey(options.apiKey);
  if (!key) throw new GlideError("FASTINO_API_KEY is not set");
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const url = `${(options.origin ?? process.env.FASTINO_API_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, "")}/v1/systemone`;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const body = JSON.stringify({ model: MODEL, state, questions });
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body, signal });
    } catch (error) {
      if (attempt === 0 && !signal.aborted) {
        await sleep(150);
        continue;
      }
      throw new GlideError(signal.aborted ? "GLiDE call timed out or was cancelled" : `GLiDE transport error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as { answers?: Record<string, GlideAnswer>; usage?: { input_tokens?: number } } | null;
      if (!json?.answers) throw new GlideError("GLiDE answered without answers", res.status);
      for (const name of Object.keys(questions)) if (!json.answers[name]) throw new GlideError(`GLiDE left question "${name}" unanswered`, res.status);
      return { answers: json.answers as GlideResult<Q>["answers"], latencyMs: Date.now() - started, inputTokens: json.usage?.input_tokens ?? 0 };
    }
    if (attempt === 0 && RETRYABLE.has(res.status)) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 1_500) : 250);
      continue;
    }
    // The body can echo the request; only the status and the API's own message leave this function.
    const message = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "request failed";
    throw new GlideError(`GLiDE ${res.status}: ${message}`, res.status);
  }
}

/** `glide`, but null whenever there is no decision to act on: no key, cooling down, or any failure (counted toward the breaker). */
export async function decide<Q extends Record<string, GlideQuestion>>(state: string | object | unknown[], questions: Q, options: GlideOptions = {}): Promise<GlideResult<Q> | null> {
  if (!glideAvailable(options.apiKey)) return null;
  try {
    const result = await glide(state, questions, options);
    failures = 0;
    return result;
  } catch {
    failures += 1;
    if (failures >= BREAKER_FAILURES) coolUntil = Date.now() + COOL_DOWN_MS;
    return null;
  }
}
