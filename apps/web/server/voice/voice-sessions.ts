import { timingSafeEqual } from "node:crypto";

import type { AppConfig } from "shared/apps";

import type { AgentRunner } from "./agent-runner";
import { IpRateLimiter, VoiceBudget, voiceLimitsFromEnv, type VoiceLimits } from "./budget";
import { defaultRealtimeTarget, type RealtimeTarget } from "./grok-realtime";
import { VoiceSession } from "./voice-session";

/** No browser listener: close soon so a missed Stop cannot keep Grok open for the whole cap. */
const IDLE_CLOSE_MS = 20_000;
const SWEEP_MS = 10_000;

export type VoiceRegistryDeps = {
  limits: VoiceLimits;
  runner: AgentRunner;
  /** Null when voice is not configured (no XAI_API_KEY). */
  target: () => RealtimeTarget | null;
  budget?: VoiceBudget;
  limiter?: IpRateLimiter;
};

export type OpenResult =
  | { ok: true; session: VoiceSession }
  | { ok: false; status: 429 | 502 | 503; error: string; retryAfterSeconds?: number };

function tokenMatches(expected: string, given: string | null): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/**
 * Live voice sessions for this process. Caps: one live session per client IP (a new one
 * replaces it), `maxLiveSessions` overall, `ipSessionsPerHour` opens per IP, the daily minute
 * budget, and `maxSessionMs` per session.
 */
export class VoiceSessionRegistry {
  readonly sessions = new Map<string, VoiceSession>();
  readonly budget: VoiceBudget;
  readonly limiter: IpRateLimiter;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: VoiceRegistryDeps) {
    this.budget = deps.budget ?? new VoiceBudget({ dataDir: deps.limits.dataDir, dailyMinutes: deps.limits.dailyMinutes });
    this.limiter = deps.limiter ?? new IpRateLimiter(deps.limits.ipSessionsPerHour);
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref?.();
  }

  sweep(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (session.isClosed) {
        this.sessions.delete(id);
        continue;
      }
      if (now - session.createdAt >= this.deps.limits.maxSessionMs) {
        session.close("max_duration");
        continue;
      }
      if (session.subscriberCount === 0 && now - session.lastActivityAt > IDLE_CLOSE_MS) {
        session.close("idle");
      }
    }
    this.limiter.prune();
    if (this.sessions.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  async open(ip: string, app: AppConfig, opts: { welcome?: boolean } = {}): Promise<OpenResult> {
    const target = this.deps.target();
    if (!target) return { ok: false, status: 503, error: "Voice mode is not configured" };
    if (this.budget.exhausted()) {
      return { ok: false, status: 429, error: "Daily voice minutes are used up. Try again tomorrow (UTC)." };
    }
    const replacing = [...this.sessions.values()].filter((s) => s.ip === ip && !s.isClosed);
    const othersLive = [...this.sessions.values()].filter((s) => !s.isClosed).length - replacing.length;
    if (othersLive >= this.deps.limits.maxLiveSessions) {
      return { ok: false, status: 429, error: "Too many live voice sessions. Try again in a few minutes." };
    }
    if (!this.limiter.tryOpen(ip)) {
      return {
        ok: false,
        status: 429,
        error: "Too many voice sessions from this address. Try again later.",
        retryAfterSeconds: this.limiter.retryAfterSeconds(ip),
      };
    }
    for (const existing of replacing) existing.close("replaced");

    const session = new VoiceSession({
      ip,
      app,
      target,
      runner: this.deps.runner,
      budget: this.budget,
      welcome: opts.welcome === true,
      maxSessionMs: this.deps.limits.maxSessionMs,
    });
    try {
      await session.connect();
    } catch (error) {
      session.close("connect_failed");
      return { ok: false, status: 502, error: error instanceof Error ? error.message : "Could not start voice mode" };
    }
    this.sessions.set(session.id, session);
    session.onClose(() => this.sessions.delete(session.id));
    this.ensureSweeper();
    return { ok: true, session };
  }

  /** Live session by id + per-session token. Null when unknown, closed, or the token is wrong. */
  get(id: string, token: string | null): VoiceSession | null {
    const session = this.sessions.get(id);
    if (!session || session.isClosed) return null;
    return tokenMatches(session.token, token) ? session : null;
  }

  closeAll(reason: string): void {
    for (const session of this.sessions.values()) session.close(reason);
    this.sessions.clear();
  }
}

/**
 * The analyst runner, looked up on each run: the registry below outlives Turbopack module reloads in dev, and a runner captured
 * when it was made would keep calling the old module's chunks ("Cannot find module") after the next edit.
 */
const latestRunner: AgentRunner = {
  async run(input, onEvent) {
    const { defaultAgentRunner: runner } = await import("./agent-runner");
    return runner.run(input, onEvent);
  },
};

/** Process-wide registry. Survives Turbopack module reloads in dev; one process in production. */
export function voiceRegistry(): VoiceSessionRegistry {
  const g = globalThis as unknown as { __inversaVoiceRegistryV2?: VoiceSessionRegistry };
  g.__inversaVoiceRegistryV2 ??= new VoiceSessionRegistry({
    limits: voiceLimitsFromEnv(),
    runner: latestRunner,
    target: defaultRealtimeTarget,
  });
  return g.__inversaVoiceRegistryV2;
}
