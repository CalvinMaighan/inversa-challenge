"use client";

/** Shared bits of the lionfish HUD: section, chips, component bar. */
import styled from "client/styled";

import { componentText, type ComponentValue } from "./model";

export const Section = styled.section`
  margin-bottom: var(--gap-m);
  h3 {
    margin: 0 0 6px;
    color: var(--muted);
    font: 600 11px / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  p {
    margin: 4px 0;
    font: 400 12.5px / 1.45 var(--font-ui);
  }
  p.muted,
  small {
    color: var(--muted);
  }
`;

export const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`;

export const Chip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text);
  font: 600 12px / 1.2 var(--font-ui);
  cursor: pointer;
  &[aria-pressed="true"] {
    border-color: var(--accent);
    background: color-mix(in oklch, var(--accent) 18%, transparent);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  small {
    color: var(--muted);
    font-weight: 500;
  }
`;

export const Tag = styled.span<{ $tone?: "warn" | "muted" | "ok" | "danger" }>`
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  border: 1px ${(p) => (p.$tone === "warn" ? "dashed" : "solid")} color-mix(in oklch, var(--${(p) => (p.$tone === "danger" ? "danger" : p.$tone === "ok" ? "ok" : p.$tone === "warn" ? "warn" : "muted")}) 70%, transparent);
  color: var(--text);
  font: 600 10.5px / 1 var(--font-mono);
  letter-spacing: 0.04em;
  white-space: nowrap;
`;

const BarBox = styled.span`
  display: inline-block;
  position: relative;
  width: 64px;
  height: 8px;
  border-radius: 4px;
  background: color-mix(in oklch, var(--muted) 25%, transparent);
  overflow: hidden;
  vertical-align: middle;
  &[data-state="unknown"],
  &[data-state="stale"] {
    background: repeating-linear-gradient(135deg, color-mix(in oklch, var(--muted) 55%, transparent) 0 3px, transparent 3px 6px);
  }
  i {
    position: absolute;
    inset: 0 auto 0 0;
    /* Neutral, not the alert red: a rank input is not a warning. */
    background: color-mix(in oklch, var(--text) 70%, transparent);
  }
`;

/** A component value as a bar on its own 0..1 scale plus the number; unknown and stale are hatched with the word. */
export function ComponentBar({ c, label }: { c: ComponentValue | null | undefined; label: string }) {
  const known = !!c && c.state === "OK" && c.value !== null;
  const state = !c ? "unknown" : c.state === "OK" && c.value === null ? "unknown" : c.state.toLowerCase();
  return (
    <span title={`${label}: ${componentText(c)} on a 0 to 1 scale`}>
      <BarBox data-state={known ? "ok" : state} aria-hidden="true">
        {known ? <i style={{ width: `${Math.round(c!.value! * 64)}px` }} /> : null}
      </BarBox>{" "}
      <b>{componentText(c)}</b>
    </span>
  );
}
