"use client";

import { useSyncExternalStore, type ReactNode } from "react";

import styled from "client/styled";

/** Phones and narrow windows: side panels turn into bottom sheets (PRD §12, 375 px target). */
export const MOBILE_QUERY = "(max-width: 640px)";
export const MOBILE = `@media ${MOBILE_QUERY}`;

/** The globe pane (a size container, client/ui/AppShell) is narrow: next to a wide chat column on a laptop. */
export const NARROW_PANE = "@container globe (max-width: 760px)";
/** The globe pane cannot fit the feed chips and the readouts on one top-bar row. */
export const COMPACT_PANE = "@container globe (max-width: 1180px)";

const subscribeMobile = (cb: () => void) => {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** True on phone-width viewports. False during SSR; layout itself is CSS, this only drives behaviour. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

/** Glass surface every HUD control sits on, so the globe reads through. Takes the pointer back from the HUD root. */
export const Surface = styled.div`
  pointer-events: auto;
  background: color-mix(in oklch, var(--surface) 82%, transparent);
  backdrop-filter: blur(10px) saturate(1.2);
  -webkit-backdrop-filter: blur(10px) saturate(1.2);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  color: var(--text);
`;

export const Mono = styled.span`
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
`;

export const IconButton = styled.button<{ $active?: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--gap-xs);
  min-width: 28px;
  height: 28px;
  padding: 0 var(--gap-s);
  border: 1px solid ${(p) => (p.$active ? "var(--accent)" : "var(--border)")};
  border-radius: var(--radius-s);
  background: ${(p) => (p.$active ? "color-mix(in oklch, var(--accent) 22%, transparent)" : "transparent")};
  color: ${(p) => (p.$active ? "var(--text)" : "var(--muted)")};
  font: 600 var(--font-xs) / 1 var(--font-ui);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  &:hover {
    color: var(--text);
    border-color: var(--hud-line);
  }
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
  svg {
    width: 14px;
    height: 14px;
  }
`;

const TONE_VAR = { ok: "var(--ok)", warn: "var(--warn)", stale: "var(--warn)", danger: "var(--danger)", muted: "var(--muted)" } as const;
export type Tone = keyof typeof TONE_VAR;

export const toneColor = (tone: Tone) => TONE_VAR[tone];

/** Small status pill. `stale` is the warn colour with a dashed border, so it differs from `lagging` without colour alone. */
export const Pill = styled.span<{ $tone: Tone }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 7px;
  border-radius: var(--radius-s);
  border: 1px ${(p) => (p.$tone === "stale" ? "dashed" : "solid")} color-mix(in oklch, ${(p) => toneColor(p.$tone)} 70%, transparent);
  background: color-mix(in oklch, ${(p) => toneColor(p.$tone)} 14%, transparent);
  color: var(--text);
  font: 600 11px / 1 var(--font-mono);
  letter-spacing: 0.04em;
  white-space: nowrap;
`;

export const Dot = styled.span<{ $tone: Tone; $pulse?: boolean }>`
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: ${(p) => toneColor(p.$tone)};
  box-shadow: 0 0 6px ${(p) => toneColor(p.$tone)};
  @keyframes hud-pulse {
    50% {
      opacity: 0.35;
    }
  }
  animation: ${(p) => (p.$pulse ? "hud-pulse 1.6s ease-in-out infinite" : "none")};
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

export const SectionTitle = styled.h3`
  margin: 0 0 var(--gap-s);
  color: var(--muted);
  font: 600 11px / 1.2 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
`;

/** Inline SVG icons: strokes in currentColor, 16 px box. */
export function Icon({ name }: { name: "play" | "pause" | "prev" | "next" | "live" | "push" | "poll" | "close" | "focus" | "chevron" | "external" | "layers" | "help" | "info" | "theme" | "bell" }) {
  const paths: Record<typeof name, ReactNode> = {
    play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
    pause: (
      <>
        <rect x="4" y="3.5" width="3" height="9" fill="currentColor" stroke="none" />
        <rect x="9" y="3.5" width="3" height="9" fill="currentColor" stroke="none" />
      </>
    ),
    prev: <path d="M11 3.5 5.5 8 11 12.5M4.5 3.5v9" />,
    next: <path d="M5 3.5 10.5 8 5 12.5M11.5 3.5v9" />,
    live: <path d="M3 8h2l2-4 2 8 2-4h2" />,
    push: <path d="M9 2 4 9h4l-1 5 5-7H8z" />,
    poll: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" />,
    close: <path d="m4 4 8 8M12 4l-8 8" />,
    focus: (
      <>
        <circle cx="8" cy="8" r="4.5" />
        <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
      </>
    ),
    chevron: <path d="m6 3.5 4.5 4.5L6 12.5" />,
    external: <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />,
    layers: <path d="M8 2 14 5.2 8 8.4 2 5.2zM2.5 8 8 11 13.5 8M2.5 10.8 8 13.8l5.5-3" />,
    info: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 7.2v4" />
        <circle cx="8" cy="4.9" r="0.45" fill="currentColor" />
      </>
    ),
    bell: <path d="M3.5 11.5h9l-1.2-1.7V7a3.3 3.3 0 0 0-6.6 0v2.8zM6.7 13.5a1.4 1.4 0 0 0 2.6 0" />,
    theme: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" stroke="none" />
      </>
    ),
    help: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.6.2-.8.6-.8 1.2v.3" />
        <circle cx="8" cy="11.6" r="0.4" fill="currentColor" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
