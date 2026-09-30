"use client";

import styled, { css, keyframes } from "client/styled";

import type { OrbPhase } from "./orb-phase";

/** Orb button size; the morph starts and ends on this rect. */
export const ORB_SIZE = 48;

/** Pulse ring while voice listens or speaks (deedee `voice-mode.styled.ts` pulse, drawn as an expanding ring). */
const ring = keyframes`
  0% { transform: scale(0.55); opacity: 0.75; }
  80%, 100% { transform: scale(1.45); opacity: 0; }
`;

const breathe = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;

const spin = keyframes`
  to { transform: rotate(360deg); }
`;

const DOT_COLOR: Record<OrbPhase, string> = {
  idle: "var(--ok)",
  connecting: "var(--warn)",
  listening: "var(--ok)",
  speaking: "var(--accent)",
  thinking: "var(--accent)",
};

export const OrbWrap = styled.div`
  position: fixed;
  z-index: 20;
  right: max(var(--gap-l), env(safe-area-inset-right));
  bottom: max(var(--gap-l), env(safe-area-inset-bottom));
  width: ${ORB_SIZE}px;
  height: ${ORB_SIZE}px;
`;

export const OrbButton = styled.button`
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 1px solid color-mix(in oklab, var(--hud-line) 70%, transparent);
  border-radius: var(--radius-round);
  background: color-mix(in oklab, var(--surface) 82%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-touch-callout: none;
  user-select: none;
  transition:
    opacity 150ms ease,
    transform 150ms ease,
    border-color 150ms ease;

  &:hover {
    border-color: var(--hud-line);
    transform: scale(1.04);
  }

  &:active {
    transform: scale(0.96);
  }

  &[data-open] {
    opacity: 0;
    pointer-events: none;
  }
`;

export const Dot = styled.span<{ $phase: OrbPhase }>`
  position: relative;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: ${({ $phase }) => DOT_COLOR[$phase]};
  color: ${({ $phase }) => DOT_COLOR[$phase]};
  box-shadow: 0 0 10px ${({ $phase }) => DOT_COLOR[$phase]};
  ${({ $phase }) =>
    $phase === "connecting"
      ? css`
          animation: ${breathe} 1s ease-in-out infinite;
        `
      : null}

  &::before,
  &::after {
    content: "";
    position: absolute;
    inset: -12px;
    border: 2px solid currentColor;
    border-radius: 50%;
    opacity: 0;
    pointer-events: none;
  }

  ${({ $phase }) =>
    $phase === "listening" || $phase === "speaking"
      ? css`
          &::before,
          &::after {
            animation: ${ring} 1.6s ease-out infinite;
          }
          &::after {
            animation-delay: 0.8s;
          }
        `
      : null}

  @media (prefers-reduced-motion: reduce) {
    animation: none;
    &::before {
      animation: none;
      opacity: ${({ $phase }) => ($phase === "listening" || $phase === "speaking" ? 0.6 : 0)};
      transform: scale(1);
    }
    &::after {
      animation: none;
    }
  }
`;

/** Subtle spinner around the dot while the agent works. */
export const Spinner = styled.span`
  position: absolute;
  inset: 9px;
  border: 1.5px solid transparent;
  border-top-color: var(--accent);
  border-right-color: color-mix(in oklab, var(--accent) 40%, transparent);
  border-radius: 50%;
  opacity: 0.85;
  animation: ${spin} 0.9s linear infinite;
  pointer-events: none;

  @media (prefers-reduced-motion: reduce) {
    animation-duration: 3s;
  }
`;

export const MicButton = styled.button`
  position: absolute;
  top: -6px;
  left: -6px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition:
    color 150ms ease,
    background 150ms ease,
    opacity 150ms ease;

  &:hover,
  &:focus-visible {
    color: var(--text);
  }

  &[aria-pressed="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }

  &[data-open] {
    opacity: 0;
    pointer-events: none;
  }

  svg {
    width: 12px;
    height: 12px;
  }
`;
