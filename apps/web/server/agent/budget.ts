/**
 * Daily token budget (`AGENT_DAILY_TOKENS`, default 2,000,000), counted in
 * process and mirrored to `<data dir>/agent-budget.json` so a restart keeps
 * the day's spend. The day rolls over at UTC midnight.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "@/server/agent/config";

const DEFAULT_DAILY_TOKENS = 2_000_000;

type BudgetFile = { day: string; used: number };

let state: BudgetFile | undefined;

function budgetPath(): string {
  return join(dataDir(), "agent-budget.json");
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function dailyTokenLimit(): number {
  const raw = Number(process.env.AGENT_DAILY_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_TOKENS;
}

function load(now: Date): BudgetFile {
  const day = today(now);
  if (state?.day === day) return state;
  let fromDisk: BudgetFile | undefined;
  try {
    const parsed = JSON.parse(readFileSync(budgetPath(), "utf8")) as Partial<BudgetFile>;
    if (parsed.day === day && typeof parsed.used === "number" && parsed.used >= 0) {
      fromDisk = { day, used: parsed.used };
    }
  } catch {
    // Missing or corrupt file: start the day at zero.
  }
  state = fromDisk ?? { day, used: 0 };
  return state;
}

function persist(current: BudgetFile): void {
  const path = budgetPath();
  mkdirSync(dataDir(), { recursive: true });
  // Write-then-rename so a crash never leaves a torn file.
  writeFileSync(`${path}.tmp`, JSON.stringify(current));
  renameSync(`${path}.tmp`, path);
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

/** Test-only: forget the in-process counter so the file is re-read. */
export function resetBudgetCache(): void {
  state = undefined;
}
