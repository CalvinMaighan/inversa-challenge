/**
 * Per-IP request rate limits for the routes that spend money: `/api/agent/stream` (an LLM turn) and
 * `/api/voice/session` (a Grok Voice socket). A sliding one-minute window per client IP, in process: the web
 * tier is one Next process behind Caddy (docs/security.md), so a shared store would buy nothing yet.
 *
 * Defaults: 10 requests per IP per minute on each route, so the 11th inside a minute gets 429 with
 * `Retry-After`. Env overrides: AGENT_RATE_PER_MIN, VOICE_RATE_PER_MIN.
 */

export const RATE_WINDOW_MS = 60_000;
export const DEFAULT_RATE_PER_MIN = 10;
/** Sweep idle IPs every this many hits, so a stream of one-off addresses cannot grow the map forever. */
const SWEEP_EVERY = 1_000;

export type RateDecision = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private sinceSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number = RATE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts the request when it is under the limit; a refused request is not counted. */
  hit(key: string): RateDecision {
    const now = this.now();
    if (++this.sinceSweep >= SWEEP_EVERY) this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true, remaining: this.limit - recent.length };
  }

  /** Tracked IPs (tests, diagnostics). */
  get size(): number {
    return this.hits.size;
  }

  sweep(now = this.now()): void {
    this.sinceSweep = 0;
    for (const [key, times] of this.hits) if (times.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
  }
}

/**
 * The client IP: the first `X-Forwarded-For` hop, then `X-Real-IP`, else one shared "local" bucket.
 * Trusting the first hop is safe only because Next listens on 127.0.0.1 and Caddy (which does not trust
 * inbound X-Forwarded-For from clients) is the only way in; see docs/security.md.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "local";
}

export type LimitedRoute = "agent" | "voice";

const ENV: Record<LimitedRoute, string> = { agent: "AGENT_RATE_PER_MIN", voice: "VOICE_RATE_PER_MIN" };

function perMinute(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n > 0 ? n : DEFAULT_RATE_PER_MIN;
}

/** One limiter per route for the process (kept on globalThis so dev module reloads do not reset it). */
export function routeLimiter(route: LimitedRoute): SlidingWindowLimiter {
  const g = globalThis as unknown as { __inversaRateLimits?: Partial<Record<LimitedRoute, SlidingWindowLimiter>> };
  const all = (g.__inversaRateLimits ??= {});
  return (all[route] ??= new SlidingWindowLimiter(perMinute(process.env[ENV[route]])));
}

/** A 429 response when this request is over its route's limit, else null (and the request is counted). */
export function rateLimited(request: Request, route: LimitedRoute): Response | null {
  const decision = routeLimiter(route).hit(clientIp(request));
  if (decision.ok) return null;
  return Response.json(
    { error: "Too many requests from this address. Try again shortly." },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds), "Cache-Control": "no-store" } },
  );
}
