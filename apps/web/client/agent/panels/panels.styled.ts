"use client";

import ExternalLink from "client/external-link";
import styled, { keyframes } from "client/styled";

/** Above the globe pane (HUD, drawer, legend) and the chat column, which share the shell's stacking context. */
export const OVERLAY_Z = 1000;

/** Data panels (PLAN.md C17). Colours come from the Emotion theme, whose values are the mode's CSS variables. */

const rise = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
`;

export const Stack = styled.section`
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
`;

export const StackHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: ${({ theme }) => theme.color.muted};
  font: 600 10px / 1.2 ${({ theme }) => theme.font.mono};
  letter-spacing: 0.08em;
  text-transform: uppercase;
`;

export const TextButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border: 1px solid ${({ theme }) => theme.color.border};
  border-radius: var(--radius-s);
  background: transparent;
  color: ${({ theme }) => theme.color.text};
  font: 600 10px / 1.2 ${({ theme }) => theme.font.mono};
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    border-color: ${({ theme }) => theme.color.accent};
    color: ${({ theme }) => theme.color.accent};
  }

  svg {
    width: 12px;
    height: 12px;
  }
`;

export const Box = styled.div<{ $open: boolean }>`
  min-width: 0;
  border: 1px solid ${({ theme, $open }) => ($open ? `color-mix(in oklab, ${theme.color.accent} 40%, ${theme.color.border})` : theme.color.border)};
  border-radius: var(--radius-s);
  background: color-mix(in oklab, ${({ theme }) => theme.color.surface2} 70%, transparent);
`;

export const Head = styled.button`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: 0;
  background: transparent;
  color: ${({ theme }) => theme.color.text};
  font: 600 12px / 1.3 ${({ theme }) => theme.font.ui};
  text-align: left;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.color.accent};
    outline-offset: -2px;
  }

  &::before {
    content: "";
    flex: 0 0 auto;
    width: 0;
    height: 0;
    border-left: 4px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    transition: transform 120ms ease;
  }

  &[aria-expanded="true"]::before {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    &::before {
      transition: none;
    }
  }
`;

export const HeadTitle = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
`;

export const Kind = styled.span`
  flex: 0 0 auto;
  padding: 0 4px;
  border: 1px solid color-mix(in oklab, ${({ theme }) => theme.color.accent} 70%, transparent);
  border-radius: 3px;
  background: color-mix(in oklab, ${({ theme }) => theme.color.accent} 18%, transparent);
  /* Body text on the tint: accent-on-tint was 2.9:1 (axe color-contrast); the border carries the accent. */
  color: ${({ theme }) => theme.color.text};
  font: 700 10px / 1.3 ${({ theme }) => theme.font.mono};
  letter-spacing: 0.08em;
  text-transform: uppercase;
`;

export const Summary = styled.span`
  flex: 0 0 auto;
  color: ${({ theme }) => theme.color.muted};
  font: 400 11px / 1.3 ${({ theme }) => theme.font.mono};
`;

export const Body = styled.div`
  padding: 0 8px 8px;
  animation: ${rise} 140ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

export const Empty = styled.p`
  margin: 4px 0;
  color: ${({ theme }) => theme.color.muted};
  font: 400 12px / 1.4 ${({ theme }) => theme.font.ui};
`;

// ---------------------------------------------------------------- table

export const TableScroll = styled.div<{ $maxHeight: number }>`
  max-height: ${({ $maxHeight }) => $maxHeight}px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  border: 1px solid ${({ theme }) => theme.color.border};
  border-radius: 4px;
`;

export const Table = styled.table`
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font: 400 11px / 1.35 ${({ theme }) => theme.font.mono};
  font-variant-numeric: tabular-nums;

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0;
    border-bottom: 1px solid ${({ theme }) => theme.color.border};
    background: ${({ theme }) => theme.color.surface};
    text-align: left;
    white-space: nowrap;
  }

  td {
    padding: 4px 8px;
    border-bottom: 1px solid color-mix(in oklab, ${({ theme }) => theme.color.border} 60%, transparent);
    white-space: nowrap;
    color: ${({ theme }) => theme.color.text};
  }

  td[data-kind="number"] {
    text-align: right;
  }

  tbody tr {
    cursor: pointer;
  }

  tbody tr:hover td,
  tbody tr:focus-visible td {
    background: color-mix(in oklab, ${({ theme }) => theme.color.accent} 14%, transparent);
  }

  tbody tr[aria-selected="true"] td {
    background: color-mix(in oklab, ${({ theme }) => theme.color.accent} 24%, transparent);
  }

  tbody tr:focus-visible {
    outline: 2px solid ${({ theme }) => theme.color.accent};
    outline-offset: -2px;
  }
`;

export const SortButton = styled.button`
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  background: transparent;
  color: ${({ theme }) => theme.color.muted};
  font: 600 10px / 1.2 ${({ theme }) => theme.font.mono};
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;

  &:hover,
  &:focus-visible,
  &[data-sorted] {
    color: ${({ theme }) => theme.color.text};
  }

  /* The sticky header sits on the scroll box's top edge, which would cut an outside ring. */
  &:focus-visible {
    outline-offset: -2px;
  }
`;

export const Tone = styled.span<{ $tone: "ok" | "warn" | "danger" | "muted" }>`
  color: ${({ theme, $tone }) => ({ ok: theme.color.ok, warn: theme.color.warn, danger: theme.color.danger, muted: theme.color.muted })[$tone]};
`;

/** The ↗ cell of a table row whose record has a page at its publisher. */
export const PageLink = styled(ExternalLink)`
  display: inline-block;
  min-width: 20px;
  padding: 0 4px;
  border-radius: 3px;
  color: ${({ theme }) => theme.color.accent};
  font-weight: 600;
  text-align: center;
  text-decoration: none;
  &:hover,
  &:focus-visible {
    background: color-mix(in oklab, ${({ theme }) => theme.color.accent} 22%, transparent);
  }
`;

export const TableFoot = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  color: ${({ theme }) => theme.color.muted};
  font: 400 11px / 1.3 ${({ theme }) => theme.font.mono};
`;

// ---------------------------------------------------------------- chart

export const Chart = styled.svg`
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
  touch-action: none;
  font: 400 10px ${({ theme }) => theme.font.mono};

  .axis {
    stroke: ${({ theme }) => theme.color.border};
  }

  .grid {
    stroke: color-mix(in oklab, ${({ theme }) => theme.color.border} 55%, transparent);
    stroke-dasharray: 2 3;
  }

  .tick {
    fill: ${({ theme }) => theme.color.muted};
  }

  .cursor {
    stroke: ${({ theme }) => theme.color.muted};
    stroke-dasharray: 3 3;
  }
`;

export const Legend = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  color: ${({ theme }) => theme.color.text};
  font: 400 11px / 1.3 ${({ theme }) => theme.font.ui};

  li {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    cursor: pointer;
  }

  i {
    flex: 0 0 auto;
    width: 10px;
    height: 3px;
    border-radius: 2px;
  }

  b {
    font: 600 11px / 1.3 ${({ theme }) => theme.font.mono};
  }
`;

// ---------------------------------------------------------------- cells, explain, backtest

export const BarList = styled.ol`
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
`;

export const BarRow = styled.li`
  display: grid;
  grid-template-columns: minmax(64px, 30%) 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  font: 400 11px / 1.3 ${({ theme }) => theme.font.mono};
  font-variant-numeric: tabular-nums;
  color: ${({ theme }) => theme.color.text};

  &[role="button"] {
    cursor: pointer;
  }

  &[role="button"]:hover,
  &[role="button"]:focus-visible {
    background: color-mix(in oklab, ${({ theme }) => theme.color.accent} 14%, transparent);
    outline: none;
  }
`;

export const Track = styled.span`
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: color-mix(in oklab, ${({ theme }) => theme.color.border} 70%, transparent);
  overflow: hidden;
`;

export const Fill = styled.span<{ $tone?: "accent" | "muted" | "ok" }>`
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 4px;
  background: ${({ theme, $tone }) => ($tone === "muted" ? theme.color.muted : $tone === "ok" ? theme.color.ok : theme.color.accent)};
`;

export const Rationale = styled.p`
  grid-column: 1 / -1;
  margin: 0 0 4px;
  color: ${({ theme }) => theme.color.muted};
  font: 400 11px / 1.4 ${({ theme }) => theme.font.ui};
  white-space: normal;
`;

export const Stat = styled.p`
  margin: 2px 0 6px;
  color: ${({ theme }) => theme.color.text};
  font: 400 12px / 1.4 ${({ theme }) => theme.font.ui};

  b {
    font: 700 13px / 1.2 ${({ theme }) => theme.font.mono};
  }
`;

export const Days = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 64px;
  padding-top: 4px;
  border-bottom: 1px solid ${({ theme }) => theme.color.border};
`;

export const Day = styled.div`
  position: relative;
  flex: 1 1 0;
  min-width: 3px;
  height: 100%;
  display: flex;
  align-items: flex-end;

  span {
    width: 100%;
    border-radius: 2px 2px 0 0;
    background: ${({ theme }) => theme.color.accent};
  }
`;

export const Baseline = styled.div`
  position: absolute;
  inset: auto 0 0 0;
  border-top: 1px dashed ${({ theme }) => theme.color.muted};
  pointer-events: none;
`;

export const Chips = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
`;

export const Chip = styled.li<{ $tone: "ok" | "warn" | "danger" | "muted" }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border: 1px solid ${({ theme }) => theme.color.border};
  border-radius: 999px;
  font: 600 10px / 1.4 ${({ theme }) => theme.font.mono};
  color: ${({ theme }) => theme.color.text};
  text-transform: uppercase;

  &::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${({ theme, $tone }) => ({ ok: theme.color.ok, warn: theme.color.warn, danger: theme.color.danger, muted: theme.color.muted })[$tone]};
  }
`;

// ---------------------------------------------------------------- expanded panel

/** `$ms`: entrance length from `motionMs(POPOUT_MS, reduced)`, 0 under reduced motion. */
export const Floating = styled.aside<{ $sheet: boolean; $ms: number }>`
  position: fixed;
  z-index: ${OVERLAY_Z};
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  border: ${({ $sheet, theme }) => ($sheet ? "0" : `1px solid color-mix(in oklab, ${theme.color.hudLine} 60%, ${theme.color.border})`)};
  border-radius: ${({ $sheet }) => ($sheet ? "0" : "var(--radius-m)")};
  background: color-mix(in oklab, ${({ theme }) => theme.color.surface} ${({ $sheet }) => ($sheet ? 100 : 92)}%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: ${({ theme }) => theme.color.shadow};
  color: ${({ theme }) => theme.color.text};
  animation-name: ${rise};
  animation-duration: ${({ $ms }) => $ms}ms;
  animation-timing-function: ease-out;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

export const FloatingHead = styled.header`
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 4px 4px 4px 12px;
  border-bottom: 1px solid ${({ theme }) => theme.color.border};
  font: 600 12px / 1.2 ${({ theme }) => theme.font.ui};
  letter-spacing: 0.06em;
  text-transform: uppercase;

  span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
`;

export const FloatingBody = styled.div`
  flex: 1;
  min-height: 0;
  padding: 10px 12px 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
`;
