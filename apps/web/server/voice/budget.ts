import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { VOICE_DAILY_MINUTES, VOICE_MAX_SESSION_MS } from "shared/voice/protocol";

/**
 * Spend caps that replace deedee's credit billing (R19): a per-session hard cap, a daily
 * minute budget shared by every session (in process, mirrored to a small JSON file under
 * `INVERSA_DATA_DIR` so a restart does not reset it), and a per-IP open rate limit.
 */

export const VOICE_USAGE_FILE = "voice-usage.json";

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export type VoiceLimits = {
  dataDir: string;
  maxSessionMs: number;
  dailyMinutes: number;
  /** Session opens allowed per client IP per rolling hour. */
  ipSessionsPerHour: number;
  /** Concurrent live sessions across all clients. */
  maxLiveSessions: number;
};

/** Env: INVERSA_DATA_DIR, VOICE_MAX_SESSION_MS, VOICE_DAILY_MINUTES, VOICE_IP_SESSIONS_PER_HOUR, VOICE_MAX_LIVE_SESSIONS. */
export function voiceLimitsFromEnv(env: Record<string, string | undefined> = process.env): VoiceLimits {
  return {
    dataDir: env.INVERSA_DATA_DIR?.trim() || "./data",
    maxSessionMs: positiveNumber(env.VOICE_MAX_SESSION_MS, VOICE_MAX_SESSION_MS),
    dailyMinutes: positiveNumber(env.VOICE_DAILY_MINUTES, VOICE_DAILY_MINUTES),
    ipSessionsPerHour: Math.floor(positiveNumber(env.VOICE_IP_SESSIONS_PER_HOUR, 20)),
    maxLiveSessions: Math.floor(positiveNumber(env.VOICE_MAX_LIVE_SESSIONS, 4)),
  };
}

/** UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

type UsageFile = { day: string; usedMs: number };

export class VoiceBudget {
  private day: string;
  private usedMs = 0;
  private readonly file: string;

  constructor(
    private readonly opts: { dataDir: string; dailyMinutes: number; now?: () => number },
  ) {
    this.file = path.join(opts.dataDir, VOICE_USAGE_FILE);
    this.day = utcDay(this.now());
    this.load();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  get limitMs(): number {
    return this.opts.dailyMinutes * 60_000;
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<UsageFile>;
      if (raw.day === this.day && typeof raw.usedMs === "number" && Number.isFinite(raw.usedMs) && raw.usedMs >= 0) {
        this.usedMs = raw.usedMs;
      }
    } catch {
      /* missing or corrupt: start the day at zero */
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.opts.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ day: this.day, usedMs: Math.round(this.usedMs) } satisfies UsageFile));
      renameSync(tmp, this.file);
    } catch (error) {
      console.error("[voice] could not persist voice usage", error);
    }
  }

  private rollover(): void {
    const today = utcDay(this.now());
    if (today === this.day) return;
    this.day = today;
    this.usedMs = 0;
    this.persist();
  }

  usedTodayMs(): number {
    this.rollover();
    return this.usedMs;
  }

  remainingMs(): number {
    return Math.max(0, this.limitMs - this.usedTodayMs());
  }

  exhausted(): boolean {
    return this.remainingMs() <= 0;
  }

  charge(ms: number): void {
    if (!(ms > 0)) return;
    this.rollover();
    this.usedMs += ms;
    this.persist();
  }
}

/** Sliding one-hour window of session opens per client IP. */
export class IpRateLimiter {
  private readonly opens = new Map<string, number[]>();

  constructor(
    private readonly perHour: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records the open and returns true when under the limit; false (nothing recorded) otherwise. */
  tryOpen(ip: string): boolean {
    const now = this.now();
    const recent = (this.opens.get(ip) ?? []).filter((at) => now - at < 3_600_000);
    if (recent.length >= this.perHour) {
      this.opens.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.opens.set(ip, recent);
    return true;
  }

  /** Drop IPs whose opens have all left the window, so the map does not grow forever. */
  prune(): void {
    const now = this.now();
    for (const [ip, opens] of this.opens) {
      if (opens.every((at) => now - at >= 3_600_000)) this.opens.delete(ip);
    }
  }

  /** Seconds until the oldest open in the window expires. */
  retryAfterSeconds(ip: string): number {
    const oldest = (this.opens.get(ip) ?? [])[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + 3_600_000 - this.now()) / 1000));
  }
}
