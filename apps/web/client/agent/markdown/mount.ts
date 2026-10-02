import { markExternalLink } from "shared/links";

import { parseStreamMarkdown, type StreamMdBlock, type StreamMdInline, type StreamMdListItem } from "./parse";

/**
 * DOM writer for streamed markdown, ported from deedee `mount-stream-markdown.ts`. Model text only ever
 * becomes text nodes and a fixed set of elements, never HTML.
 */

/** Verified citations for one message, keyed by evidence id. `n` is the chip's number (first-cited order). */
export type CiteIndex = ReadonlyMap<string, { n: number; label: string }>;

/** Class and attribute the card's click delegation looks for. */
export const CITE_CLASS = "agent-cite";
export const EVIDENCE_ATTR = "data-evidence-id";

export function citeChip(id: string, n: number, label: string): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = CITE_CLASS;
  chip.setAttribute(EVIDENCE_ATTR, id);
  chip.title = label;
  chip.setAttribute("aria-label", `Evidence ${n}: ${label}`);
  chip.textContent = String(n);
  return chip;
}

function appendInlines(parent: ParentNode, nodes: StreamMdInline[], cites: CiteIndex): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        parent.append(node.text);
        break;
      case "code": {
        const code = document.createElement("code");
        code.textContent = node.text;
        parent.append(code);
        break;
      }
      case "cite": {
        const cite = cites.get(node.id);
        if (cite) parent.append(citeChip(node.id, cite.n, cite.label));
        break;
      }
      case "a": {
        const link = document.createElement("a");
        link.setAttribute("href", node.href);
        // Other origins open in a new tab; a link back into the app stays in this one.
        markExternalLink(link);
        appendInlines(link, node.children, cites);
        parent.append(link);
        break;
      }
      default: {
        const el = document.createElement(node.kind);
        appendInlines(el, node.children, cites);
        parent.append(el);
      }
    }
  }
}

function appendItem(list: HTMLElement, item: StreamMdListItem, cites: CiteIndex): void {
  const li = document.createElement("li");
  appendInlines(li, item.inlines, cites);
  if (item.child) appendBlock(li, item.child, cites);
  list.append(li);
}

function appendTable(host: HTMLElement, block: Extract<StreamMdBlock, { kind: "table" }>, cites: CiteIndex): void {
  const scroll = document.createElement("div");
  scroll.className = "md-table";
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const cell of block.headers) {
    const th = document.createElement("th");
    appendInlines(th, cell, cites);
    head.append(th);
  }
  const thead = document.createElement("thead");
  thead.append(head);
  const tbody = document.createElement("tbody");
  for (const row of block.rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      appendInlines(td, cell, cites);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  scroll.append(table);
  host.append(scroll);
}

function appendBlock(host: HTMLElement, block: StreamMdBlock, cites: CiteIndex): void {
  switch (block.kind) {
    case "p": {
      const p = document.createElement("p");
      appendInlines(p, block.children, cites);
      host.append(p);
      return;
    }
    case "h": {
      const heading = document.createElement(`h${Math.min(6, Math.max(1, block.level))}`);
      appendInlines(heading, block.children, cites);
      host.append(heading);
      return;
    }
    case "ul":
    case "ol": {
      const list = document.createElement(block.kind);
      if (block.kind === "ol" && block.start && block.start !== 1) (list as HTMLOListElement).start = block.start;
      for (const item of block.items) appendItem(list, item, cites);
      host.append(list);
      return;
    }
    case "pre": {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (block.lang) code.dataset.lang = block.lang;
      code.textContent = block.text;
      pre.append(code);
      host.append(pre);
      return;
    }
    case "quote": {
      const quote = document.createElement("blockquote");
      appendInlines(quote, block.children, cites);
      host.append(quote);
      return;
    }
    case "table":
      appendTable(host, block, cites);
      return;
    case "hr":
      host.append(document.createElement("hr"));
  }
}

/** Replace `host`'s children with `text` rendered as markdown; verified `[e:id]` markers become chips. */
export function mountStreamMarkdown(host: HTMLElement, text: string, cites: CiteIndex): void {
  host.replaceChildren();
  if (!text) return;
  for (const block of parseStreamMarkdown(text, (id) => cites.has(id))) appendBlock(host, block, cites);
}
