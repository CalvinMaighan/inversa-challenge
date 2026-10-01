/**
 * Daily agent spend caps, counted in process and mirrored to `<data dir>/agent-budget.json` so a restart keeps
 * the day's spend. The day rolls over at UTC midnight. Three caps, any one of which refuses the next turn:
 *
 * - tokens, all apps: `AGENT_DAILY_TOKENS`, default 100,000,000 ($10 of input at list price, so the dollar caps
 *   bind first; it is the backstop if a price is set wrong);
 * - dollars, all apps: `AGENT_DAILY_USD`, default $5;
 * - dollars, per app: `AGENT_APP_DAILY_USD`, default $2, so one app's traffic cannot use up the other two's day.
 *
 * Dollars are priced from the turn's usage at GPT-6 Luna's OpenRouter list price, $0.10/M input and $0.50/M
 * output (`AGENT_PRICE_IN_PER_M`, `AGENT_PRICE_OUT_PER_M`). Cache reads are charged as input, which overstates
 * them: a cap that errs high stops early, never late.
 *
 * Caps are checked before a turn starts and spend is recorded when it ends, so turns already running when a cap
 * is crossed finish (each is bounded by `cordis/limits.ts`, and the route bounds how many run at once): the
 * overshoot is at most `AGENT_MAX_CONCURRENT` turns.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "@/server/agent/config";

export const DEFAULT_DAILY_TOKENS = 100_000_000;
export const DEFAULT_DAILY_USD = 5;
export const DEFAULT_APP_DAILY_USD = 2;
export const DEFAULT_PRICE_IN_PER_M = 0.1;
export const DEFAULT_PRICE_OUT_PER_M = 0.5;

type BudgetFile = { day: string; used: number; usd: number; apps: Record<string, number> };

export type TurnUsageLike = { promptTokens: number; completionTokens: number; cacheRead: number };

let state: BudgetFile | undefined;

function budgetPath(): string {
  return join(dataDir(), "agent-budget.json");
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function dailyTokenLimit(): number {
  return Math.floor(positive(process.env.AGENT_DAILY_TOKENS, DEFAULT_DAILY_TOKENS));
}

/** The dollar caps in force: `global` for all apps together, `perApp` for each app. */
export function dailyUsdLimits(): { global: number; perApp: number } {
  return {
    global: positive(process.env.AGENT_DAILY_USD, DEFAULT_DAILY_USD),
    perApp: positive(process.env.AGENT_APP_DAILY_USD, DEFAULT_APP_DAILY_USD),
  };
}

/** Dollars a turn cost at the configured prices. */
export function turnCostUsd(usage: TurnUsageLike): number {
  const inPerM = positive(process.env.AGENT_PRICE_IN_PER_M, DEFAULT_PRICE_IN_PER_M);
  const outPerM = positive(process.env.AGENT_PRICE_OUT_PER_M, DEFAULT_PRICE_OUT_PER_M);
  const input = Math.max(0, usage.promptTokens) + Math.max(0, usage.cacheRead);
  return (input * inPerM + Math.max(0, usage.completionTokens) * outPerM) / 1_000_000;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function load(now: Date): BudgetFile {
  const day = today(now);
  if (state?.day === day) return state;
  let fromDisk: BudgetFile | undefined;
  try {
    const parsed = JSON.parse(readFileSync(budgetPath(), "utf8")) as Partial<BudgetFile>;
    if (parsed.day === day && finite(parsed.used)) {
      const apps: Record<string, number> = {};
      for (const [id, usd] of Object.entries(parsed.apps ?? {})) if (finite(usd)) apps[id] = usd;
      fromDisk = { day, used: parsed.used, usd: finite(parsed.usd) ? parsed.usd : 0, apps };
    }
  } catch {
    // Missing or corrupt file: start the day at zero.
  }
  state = fromDisk ?? { day, used: 0, usd: 0, apps: {} };
  return state;
}

function persist(current: BudgetFile): void {
  // The in-process counter is the authority; the file only survives restarts. A full or read-only disk must not
  // turn every finished answer into an error, so a failed write is logged and the day carries on in memory.
  try {
    const path = budgetPath();
    mkdirSync(dataDir(), { recursive: true });
    // Write-then-rename so a crash never leaves a torn file.
    writeFileSync(`${path}.tmp`, JSON.stringify(current));
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    console.error(`[agent-budget] could not persist ${budgetPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function tokenBudget(now = new Date()): { day: string; used: number; limit: number; remaining: number } {
  const current = load(now);
  const limit = dailyTokenLimit();
  return { day: current.day, used: current.used, limit, remaining: Math.max(0, limit - current.used) };
}

export function recordTokens(tokens: number, now = new Date()): void {
  if (!(tokens > 0)) return;
  const current = load(now);
  current.used += Math.round(tokens);
  persist(current);
}

/** Records one finished turn of `app`: its tokens and its dollars, globally and for the app. */
export function recordUsage(app: string, usage: TurnUsageLike, now = new Date()): void {
  const tokens = Math.max(0, usage.promptTokens) + Math.max(0, usage.cacheRead) + Math.max(0, usage.completionTokens);
  if (!(tokens > 0)) return;
  const current = load(now);
  const usd = turnCostUsd(usage);
  current.used += Math.round(tokens);
  current.usd += usd;
  current.apps[app] = (current.apps[app] ?? 0) + usd;
  persist(current);
}

export type SpendRefusal = {
  /** Which cap: the shared token cap, the shared dollar cap, or this app's dollar cap. */
  cap: "tokens" | "global_usd" | "app_usd";
  message: string;
};

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Null when `app` may start a turn now, else which cap is used up, in words the UI shows as is. */
export function spendRefusal(app: string, now = new Date()): SpendRefusal | null {
  const tokens = tokenBudget(now);
  if (tokens.remaining <= 0) {
    return { cap: "tokens", message: `Daily agent token budget (${tokens.limit.toLocaleString("en-US")}) is used up. It resets at 00:00 UTC.` };
  }
  const current = load(now);
  const limits = dailyUsdLimits();
  if (current.usd >= limits.global) {
    return { cap: "global_usd", message: `The agent's daily spending cap (${usd(limits.global)} across all apps) is used up. It resets at 00:00 UTC.` };
  }
  if ((current.apps[app] ?? 0) >= limits.perApp) {
    return { cap: "app_usd", message: `This app's daily agent spending cap (${usd(limits.perApp)}) is used up. It resets at 00:00 UTC.` };
  }
  return null;
}

/** Today's spend, for health and diagnostics. */
export function spendToday(now = new Date()): { day: string; tokens: number; usd: number; apps: Record<string, number> } {
  const current = load(now);
  return { day: current.day, tokens: current.used, usd: current.usd, apps: { ...current.apps } };
}

/** Test-only: forget the in-process counter so the file is re-read. */
export function resetBudgetCache(): void {
  state = undefined;
}
