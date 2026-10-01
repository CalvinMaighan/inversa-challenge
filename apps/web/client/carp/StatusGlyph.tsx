"use client";

import type { Freshness } from "./model";
import type { ReviewStatus } from "./review";

/** Status in colour, shape and icon (never colour alone): review ◆ with "!", fine ● with a tick, cannot assess ■ with "?". */
export const STATUS_TONE: Record<ReviewStatus, string> = { review: "var(--warn)", ok: "var(--ok)", cannot_assess: "var(--muted)" };

export const FRESHNESS_WORDS: Record<Freshness, string> = {
  FRESH: "observed within 2 h",
  AGING: "observed 2 to 6 h ago",
  STALE: "newest observation older than 6 h",
  MISSING: "no observation held",
};

const RING: Record<Freshness, { color: string; dash: string }> = {
  FRESH: { color: "var(--ok)", dash: "" },
  AGING: { color: "var(--warn)", dash: "" },
  STALE: { color: "var(--danger)", dash: "3 2" },
  MISSING: { color: "var(--muted)", dash: "1 2.5" },
};

/** The marker body: shape + icon in the status tone, on a dark plate so it reads over imagery. */
export function StatusGlyph({ status, size = 18 }: { status: ReviewStatus; size?: number }) {
  const tone = STATUS_TONE[status];
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" data-glyph={status}>
      {status === "review" ? (
        <>
          <path d="M10 1.5 18.5 10 10 18.5 1.5 10z" fill={tone} stroke="#0b0d12" strokeWidth="1.2" />
          <path d="M10 5.6v5.4" stroke="#0b0d12" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="10" cy="14" r="1.25" fill="#0b0d12" />
        </>
      ) : status === "ok" ? (
        <>
          <circle cx="10" cy="10" r="8" fill={tone} stroke="#0b0d12" strokeWidth="1.2" />
          <path d="m6.3 10.2 2.6 2.6 4.9-5.2" fill="none" stroke="#0b0d12" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <rect x="2.5" y="2.5" width="15" height="15" rx="2" fill="#2a2f38" stroke={tone} strokeWidth="1.6" strokeDasharray="3 2" />
          <path d="M7.7 7.6a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1.1.8-1.1 1.6v.4" fill="none" stroke="#e8edf2" strokeWidth="1.7" strokeLinecap="round" />
          <circle cx="10" cy="14.4" r="1.05" fill="#e8edf2" />
        </>
      )}
    </svg>
  );
}

/** Freshness ring around a marker: solid green, solid amber, dashed red, dotted grey. */
export function FreshnessRing({ freshness, size }: { freshness: Freshness; size: number }) {
  const r = RING[freshness];
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" data-ring={freshness.toLowerCase()} style={{ position: "absolute", inset: 0 }}>
      <circle cx="16" cy="16" r="14.5" fill="none" stroke={r.color} strokeWidth="2.2" strokeDasharray={r.dash || undefined} />
    </svg>
  );
}
