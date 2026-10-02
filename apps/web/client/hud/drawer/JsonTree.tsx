"use client";

import type { ReactNode } from "react";

import styled from "client/styled";

/** Stop rendering after this many nodes; a raw GOES or GBIF payload can hold thousands. */
const MAX_NODES = 1500;
/** Objects and arrays up to this depth start expanded. */
const OPEN_DEPTH = 1;

const Tree = styled.div`
  font: 12px / 1.5 var(--font-mono);
  overflow-x: auto;
  details {
    margin-left: 12px;
  }
  & > details {
    margin-left: 0;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
    list-style: revert;
  }
  .k {
    color: var(--text);
  }
  .s {
    color: var(--ok);
  }
  .n {
    color: var(--warn);
  }
  .l {
    color: var(--muted);
  }
  .row {
    margin-left: 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }
`;

function leaf(value: unknown): ReactNode {
  if (value === null) return <span className="l">null</span>;
  if (typeof value === "string") return <span className="s">{JSON.stringify(value)}</span>;
  if (typeof value === "number" || typeof value === "boolean") return <span className="n">{String(value)}</span>;
  return <span className="l">{String(value)}</span>;
}

/**
 * Raw payload, pretty-printed as a collapsible tree: each object and array is a `<details>`, the first level
 * open. Keys keep their source order. Past `MAX_NODES` the rest is summarized, not rendered.
 */
export default function JsonTree({ value }: { value: unknown }) {
  let budget = MAX_NODES;
  const node = (key: string | null, v: unknown, depth: number, path: string): ReactNode => {
    budget--;
    const label = key === null ? null : <span className="k">{key}: </span>;
    if (budget < 0) return null;
    if (v === null || typeof v !== "object") {
      return (
        <div className="row" key={path}>
          {label}
          {leaf(v)}
        </div>
      );
    }
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
    const brackets = Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`;
    const shown: ReactNode[] = [];
    for (const [k, x] of entries) {
      if (budget <= 0) {
        shown.push(
          <div className="row l" key={`${path}/…`}>
            … {entries.length - shown.length} more
          </div>,
        );
        break;
      }
      shown.push(node(k, x, depth + 1, `${path}/${k}`));
    }
    return (
      <details key={path} open={depth <= OPEN_DEPTH}>
        <summary>
          {label}
          {brackets}
        </summary>
        {shown}
      </details>
    );
  };
  return <Tree>{node(null, value, 0, "$")}</Tree>;
}
