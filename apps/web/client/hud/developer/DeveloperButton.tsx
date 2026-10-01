"use client";

import { useCallback, useRef, useState } from "react";

import styled from "client/styled";

import { Surface } from "../primitives";
import DeveloperPanel from "./DeveloperPanel";

const Round = styled(Surface.withComponent("button"))`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  color: var(--text);
  cursor: pointer;

  svg {
    width: 18px;
    height: 18px;
  }

  &:hover,
  &[aria-expanded="true"] {
    border-color: var(--hud-line);
  }
`;

/** A key: the Developer panel holds every API key the app can use. */
function KeyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="10.5" r="2.8" />
      <path d="M7 8.5 13 2.5M11 4.5l1.8 1.8M9.4 6.1l1.4 1.4" />
    </svg>
  );
}

/** The top-right Developer button (docs/GODS_EYE.md GC1) and the "Power up the globe" panel it opens. */
export default function DeveloperButton() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <Round
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Developer: API keys"
        title="Developer: API keys"
        data-testid="developer-button"
        onClick={() => setOpen((v) => !v)}
      >
        <KeyIcon />
      </Round>
      {open ? <DeveloperPanel onClose={close} /> : null}
    </>
  );
}
