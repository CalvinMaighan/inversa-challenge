"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import styled from "client/styled";

import { Icon, IconButton, MOBILE } from "../primitives";

/**
 * The provider rows of the Developer panel (docs/GODS_EYE.md "Developer panel spec"): GE3 sets this to its
 * panel body from client/hud/developer. The frame below (title, close, Esc, intro) stays.
 */
const PANEL_BODY: ReactNode = null;

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: var(--gap-m);
  background: rgb(0 0 0 / 55%);
`;

const Dialog = styled.div`
  width: min(560px, 100%);
  max-height: calc(100dvh - 2 * var(--gap-m));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--gap-m) var(--gap-l) var(--gap-l);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow);
  color: var(--text);
  font: 400 13px / 1.5 var(--font-ui);

  &:focus-visible {
    outline-offset: -2px;
  }

  > p {
    margin: 0 0 var(--gap-s);
    color: var(--muted);
  }

  ${MOBILE} {
    padding: var(--gap-m);
  }
`;

const Head = styled.header`
  display: flex;
  align-items: flex-start;
  gap: var(--gap-s);
  margin-bottom: var(--gap-s);

  > div {
    flex: 1;
    min-width: 0;
  }

  small {
    display: block;
    color: var(--muted);
    font: 600 10px / 1.6 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font: 600 18px / 1.3 var(--font-ui);
  }

  kbd {
    color: var(--muted);
    font: 400 11px / 28px var(--font-mono);
    white-space: nowrap;
  }
`;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A modal keeps Tab inside: past the last control back to the first, and Shift+Tab the other way. */
function trapTab(e: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dialog)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * The Developer panel's mount (GE1): a modal over the page, opened by the Developer icon button top right.
 * Focus moves into it and Tab stays inside; Esc, the close button or a click on the backdrop close it and the
 * button gets focus back (TopBar). Rendered into <body>, so no HUD container clips or positions it.
 */
export default function DeveloperSlot({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <Backdrop
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Dialog
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="developer-panel"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "Tab") trapTab(e, ref.current);
        }}
      >
        <Head>
          <div>
            <small>Provider settings</small>
            <h2 id={titleId}>Power up the globe</h2>
          </div>
          <kbd>Esc to close</kbd>
          <IconButton type="button" onClick={onClose} aria-label="Close developer panel">
            <Icon name="close" />
          </IconButton>
        </Head>
        <p>The globe works without keys. Each key switches on another real feed.</p>
        {PANEL_BODY}
      </Dialog>
    </Backdrop>,
    document.body,
  );
}
