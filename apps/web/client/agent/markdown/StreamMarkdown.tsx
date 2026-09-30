"use client";

import { useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";

import type { AgentCitation } from "client/state/agent";

import { Body } from "../card.styled";
import { EVIDENCE_ATTR, mountStreamMarkdown, type CiteIndex } from "./mount";

export function citeIndex(citations: readonly AgentCitation[]): CiteIndex {
  return new Map(citations.map((c, i) => [c.id, { n: i + 1, label: c.label }]));
}

/**
 * Incremental markdown (deedee `ShellChatAssistantStreamText`): the text is re-mounted into the host on each
 * batch, outside React's reconciler. Chip clicks are delegated to `onCite`.
 */
export default function StreamMarkdown({
  text,
  citations,
  onCite,
}: {
  text: string;
  citations: readonly AgentCitation[];
  onCite: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cites = useMemo(() => citeIndex(citations), [citations]);

  useLayoutEffect(() => {
    if (hostRef.current) mountStreamMarkdown(hostRef.current, text, cites);
  }, [text, cites]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const chip = (event.target as Element).closest?.(`[${EVIDENCE_ATTR}]`);
    const id = chip?.getAttribute(EVIDENCE_ATTR);
    if (id) onCite(id);
  };

  return <Body ref={hostRef} onClick={onClick} />;
}
