/**
 * Answer cache keyed by (normalized question, data version). The data version
 * is the newest `lastFetchAt` across feeds, so any new fetch misses the cache.
 * A hit replays the recorded event stream. Entries live 10 minutes.
 */

import type { AgentStreamEvent } from "@/shared/agent/events";

export const ANSWER_CACHE_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 200;

export type CachedAnswer = { events: AgentStreamEvent[]; content: string; citations: string[]; storedAt: number };

const entries = new Map<string, CachedAnswer>();

/** Case, whitespace and trailing punctuation do not change the question. */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[\s?!.]+$/, "")
    .trim();
}

const FRAME_MS = 15 * 60_000;

/**
 * Tools default their area to the view bbox and "now" to the reference time,
 * so both scope the key: bbox to 0.01°, time to its 15-minute frame (C15).
 */
export function answerCacheKey(
  question: string,
  dataVersion: string,
  scope?: { bbox?: { west: number; south: number; east: number; north: number }; now?: Date },
): string {
  const bbox = scope?.bbox
    ? [scope.bbox.west, scope.bbox.south, scope.bbox.east, scope.bbox.north].map((value) => value.toFixed(2)).join(",")
    : "region";
  const frame = scope?.now ? Math.floor(scope.now.getTime() / FRAME_MS) : "now";
  return [dataVersion, bbox, frame, normalizeQuestion(question)].join("\u0000");
}

export function readAnswerCache(key: string, now = Date.now()): CachedAnswer | undefined {
  const hit = entries.get(key);
  if (!hit) return undefined;
  if (now - hit.storedAt > ANSWER_CACHE_TTL_MS) {
    entries.delete(key);
    return undefined;
  }
  return hit;
}

export function writeAnswerCache(key: string, answer: Omit<CachedAnswer, "storedAt">, now = Date.now()): void {
  entries.delete(key);
  entries.set(key, { ...answer, storedAt: now });
  // Map iteration is insertion order: evict the oldest.
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

export function clearAnswerCache(): void {
  entries.clear();
}
