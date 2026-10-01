"use client";

import { useEffect, useRef } from "react";

import ExternalLink from "client/external-link";
import { Icon, IconButton, MOBILE, Surface } from "client/hud/primitives";
import styled from "client/styled";

import { HELP, RELEVANCE } from "./help";
import type { HelpTopic } from "./store";

const Sheet = styled(Surface)`
  position: absolute;
  z-index: 7;
  top: var(--hud-top);
  left: 50%;
  transform: translateX(-50%);
  width: min(640px, calc(100cqw - 2 * var(--gap-m)));
  max-height: calc(100% - var(--hud-top) - var(--hud-bottom) - var(--gap-m));
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-m);
  overflow: hidden;
  &:focus-visible {
    outline-offset: -2px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 14px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    flex: 1;
    margin: 0;
    font: 600 14px / 1.3 var(--font-ui);
  }
  .body {
    overflow: auto;
    overscroll-behavior: contain;
    padding: 10px 14px 14px;
    font: 400 12.5px / 1.5 var(--font-ui);
  }
  article {
    padding: 8px 0;
    border-top: 1px solid var(--border);
  }
  article[data-current] h3 {
    color: var(--accent);
  }
  h3 {
    margin: 0 0 4px;
    font: 600 13px / 1.3 var(--font-ui);
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 10px;
    margin: 0;
  }
  dt {
    color: var(--muted);
    font: 600 10.5px / 19px var(--font-mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  dd {
    margin: 0;
    min-width: 0;
  }
  a {
    color: var(--accent);
    font-weight: 600;
  }
  a svg {
    display: inline-block;
    width: 11px;
    height: 11px;
    vertical-align: -1px;
  }
  ul {
    margin: 4px 0 8px;
    padding-left: 18px;
  }
  ${MOBILE} {
    top: auto;
    bottom: 0;
    left: 0;
    right: 0;
    width: auto;
    transform: none;
    max-height: 80dvh;
    border-radius: var(--radius-l) var(--radius-l) 0 0;
  }
`;

export type OceanHelpProps = { topic: HelpTopic | "all"; onClose: () => void };

/** The ocean-data guide: six topics (what, why, source, limits) and what the view will not claim. */
export default function OceanHelp({ topic, onClose }: OceanHelpProps) {
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });
    if (topic !== "all") ref.current?.querySelector(`[data-help-topic="${topic}"]`)?.scrollIntoView({ block: "start" });
    const returnTo = back;
    return () => {
      if (returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true });
    };
  }, [topic]);
  return (
    <Sheet
      as="section"
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label="Ocean data guide"
      data-testid="lionfish-help"
      data-hud-obstacle=""
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2>Ocean data guide</h2>
        <IconButton type="button" onClick={onClose} aria-label="Close guide">
          <Icon name="close" />
        </IconButton>
      </header>
      <div className="body">
        <p>What each ocean measurement is, why the survey view uses it, where it comes from and what it cannot tell you.</p>
        <ul data-testid="lionfish-help-relevance">
          {RELEVANCE.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {HELP.map((h) => (
          <article key={h.id} data-help-topic={h.id} data-current={topic === h.id ? "" : undefined}>
            <h3>{h.title}</h3>
            <dl>
              <dt>What</dt>
              <dd>{h.what}</dd>
              <dt>Why</dt>
              <dd>{h.why}</dd>
              <dt>Source</dt>
              <dd data-help-source="">
                {h.source}{" "}
                {h.links.map((l, i) => (
                  <span key={l.href}>
                    {i ? " · " : ""}
                    <ExternalLink href={l.href}>
                      {l.label}&nbsp;<Icon name="external" />
                    </ExternalLink>
                  </span>
                ))}
              </dd>
              <dt>Limits</dt>
              <dd data-help-limits="">{h.limits}</dd>
            </dl>
          </article>
        ))}
      </div>
    </Sheet>
  );
}
