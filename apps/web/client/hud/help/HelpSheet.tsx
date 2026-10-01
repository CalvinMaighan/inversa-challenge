"use client";

import { useEffect, useRef } from "react";

import styled from "client/styled";

import { Icon, IconButton } from "../primitives";
import { HELP_ENTRIES, HELP_GROUPS } from "./content";

const Sheet = styled.section`
  position: absolute;
  z-index: 8;
  top: var(--hud-top);
  left: 50%;
  display: flex;
  flex-direction: column;
  width: min(620px, calc(100% - 2 * var(--gap-m)));
  max-height: calc(100% - var(--hud-top) - var(--gap-m));
  transform: translateX(-50%);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow);
  color: var(--text);
`;

const Head = styled.header`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  padding: 6px 6px 6px var(--gap-m);
  border-bottom: 1px solid var(--border);

  h2 {
    flex: 1;
    margin: 0;
    font: 600 var(--font-xs) / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
`;

const Body = styled.div`
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--gap-s) var(--gap-m) var(--gap-m);
  columns: 2 280px;
  column-gap: var(--gap-l);
  scrollbar-width: thin;

  &:focus-visible {
    outline-offset: -2px;
  }
`;

const Group = styled.section`
  break-inside: avoid;
  margin-bottom: var(--gap-m);

  h3 {
    margin: 0 0 4px;
    color: var(--muted);
    font: 600 11px / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  dl {
    margin: 0;
  }

  dt {
    margin-top: 6px;
    font: 600 12.5px / 1.3 var(--font-ui);
  }

  dd {
    margin: 1px 0 0;
    color: var(--muted);
    font: 400 12px / 1.45 var(--font-ui);
  }
`;

/**
 * The "?" sheet (T40): every control on the page and what it does, from `content.ts` (the same list README's UI
 * section is checked against). Esc, the close button or a click outside closes it; focus returns to "?".
 */
export default function HelpSheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && !ref.current?.contains(target) && !(target instanceof Element && target.closest("[data-help-button]"))) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      opener?.focus();
    };
  }, [onClose]);

  return (
    <Sheet ref={ref} role="dialog" aria-modal="false" aria-labelledby="help-title" data-testid="help-sheet" data-hud-obstacle="">
      <Head>
        <h2 id="help-title">Controls</h2>
        <IconButton ref={closeRef} type="button" aria-label="Close help" onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      </Head>
      {/* Text only and scrollable: focusable so the keyboard can scroll it (axe scrollable-region-focusable). */}
      <Body tabIndex={0} role="region" aria-labelledby="help-title">
        {HELP_GROUPS.map((group) => (
          <Group key={group} aria-label={group}>
            <h3>{group}</h3>
            <dl>
              {HELP_ENTRIES.filter((e) => e.group === group).map((e) => (
                <div key={e.id} data-help-entry={e.id}>
                  <dt>{e.control}</dt>
                  <dd>{e.what}</dd>
                </div>
              ))}
            </dl>
          </Group>
        ))}
      </Body>
    </Sheet>
  );
}
