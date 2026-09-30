/**
 * Streaming-safe markdown subset, ported from deedee `shared/shell/chat/stream-markdown.ts`. Half-written
 * syntax (an unclosed `**`, a link still streaming) degrades to text instead of flashing raw markers.
 *
 * Added here: evidence citations. `[e:<id>]` (PLAN.md C14) becomes a `cite` node when `isCited(id)` says the
 * server verified it (a `citation` event arrived); any other marker is dropped, never shown as a chip.
 */

export type StreamMdInline =
  | { kind: "text"; text: string }
  | { kind: "b" | "i" | "s"; children: StreamMdInline[] }
  | { kind: "code"; text: string }
  | { kind: "a"; href: string; children: StreamMdInline[] }
  | { kind: "cite"; id: string };

export type StreamMdListItem = {
  inlines: StreamMdInline[];
  child?: Extract<StreamMdBlock, { kind: "ul" | "ol" }>;
};

export type StreamMdBlock =
  | { kind: "p"; children: StreamMdInline[] }
  | { kind: "h"; level: number; children: StreamMdInline[] }
  | { kind: "ul" | "ol"; items: StreamMdListItem[]; start?: number }
  | { kind: "pre"; lang: string; text: string }
  | { kind: "quote"; children: StreamMdInline[] }
  | { kind: "hr" }
  | { kind: "table"; headers: StreamMdInline[][]; rows: StreamMdInline[][][] };

export type IsCited = (id: string) => boolean;

const SAFE_HREF = /^https?:\/\//i;
const CITE_OPEN = "[e:";

function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

function findHrefClose(src: string, from: number): number {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length) {
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findUnescaped(src: string, needle: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const at = src.indexOf(needle, i);
    if (at < 0) return -1;
    if (at > 0 && src[at - 1] === "\\") {
      i = at + needle.length;
      continue;
    }
    return at;
  }
  return -1;
}

function mergeText(nodes: StreamMdInline[]): StreamMdInline[] {
  const out: StreamMdInline[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.kind === "text" && last?.kind === "text") last.text += node.text;
    else out.push(node);
  }
  return out;
}

export function parseInlines(src: string, isCited: IsCited): StreamMdInline[] {
  const out: StreamMdInline[] = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end <= textStart) return;
    out.push({ kind: "text", text: src.slice(textStart, end) });
  };
  const push = (node: StreamMdInline) => {
    flushText(i);
    out.push(node);
  };
  const nested = (from: number, to?: number) => parseInlines(src.slice(from, to), isCited);

  while (i < src.length) {
    if (src[i] === "\\" && i + 1 < src.length) {
      flushText(i);
      out.push({ kind: "text", text: src[i + 1]! });
      i += 2;
      textStart = i;
      continue;
    }

    if (src.startsWith(CITE_OPEN, i)) {
      const close = src.indexOf("]", i + CITE_OPEN.length);
      // A marker still streaming in: hide it until it closes.
      if (close < 0) {
        flushText(i);
        return mergeText(out);
      }
      const id = src.slice(i + CITE_OPEN.length, close).trim();
      flushText(i);
      if (id && isCited(id)) {
        out.push({ kind: "cite", id });
      } else {
        // Dropped marker: do not leave "word ." behind.
        const last = out[out.length - 1];
        const after = src[close + 1];
        if (last?.kind === "text" && (after === undefined || /[.,;:!?)]/.test(after))) last.text = last.text.replace(/[ \t]+$/, "");
      }
      i = close + 1;
      textStart = i;
      continue;
    }

    if (src.startsWith("`", i)) {
      const close = src.indexOf("`", i + 1);
      if (close < 0) {
        flushText(i);
        out.push({ kind: "text", text: src.slice(i + 1) });
        return mergeText(out);
      }
      push({ kind: "code", text: src.slice(i + 1, close) });
      i = close + 1;
      textStart = i;
      continue;
    }

    if (src.startsWith("***", i) || src.startsWith("___", i)) {
      const mark = src.slice(i, i + 3);
      const close = findUnescaped(src, mark, i + 3);
      if (close < 0) {
        flushText(i);
        out.push(...nested(i + 3));
        return mergeText(out);
      }
      push({ kind: "b", children: [{ kind: "i", children: nested(i + 3, close) }] });
      i = close + 3;
      textStart = i;
      continue;
    }

    if (src.startsWith("**", i) || src.startsWith("__", i)) {
      const mark = src.slice(i, i + 2);
      const close = findUnescaped(src, mark, i + 2);
      if (close < 0) {
        flushText(i);
        out.push(...nested(i + 2));
        return mergeText(out);
      }
      push({ kind: "b", children: nested(i + 2, close) });
      i = close + 2;
      textStart = i;
      continue;
    }

    if (src.startsWith("~~", i)) {
      const close = findUnescaped(src, "~~", i + 2);
      if (close < 0) {
        flushText(i);
        out.push(...nested(i + 2));
        return mergeText(out);
      }
      push({ kind: "s", children: nested(i + 2, close) });
      i = close + 2;
      textStart = i;
      continue;
    }

    if (src[i] === "*" || src[i] === "_") {
      const mark = src[i]!;
      const prev = src[i - 1];
      const next = src[i + 1];
      // snake_case ids (needs_id, feed_state) are words, not emphasis.
      const midWord = mark === "_" && prev !== undefined && /[A-Za-z0-9]/.test(prev) && next !== undefined && /[A-Za-z0-9]/.test(next);
      if (!midWord && next && !isWs(next)) {
        const close = findUnescaped(src, mark, i + 1);
        const closerOk = close > i + 1 && !isWs(src[close - 1]) && src[close + 1] !== mark;
        if (closerOk) {
          push({ kind: "i", children: nested(i + 1, close) });
          i = close + 1;
          textStart = i;
          continue;
        }
        if (close < 0) {
          flushText(i);
          out.push(...nested(i + 1));
          return mergeText(out);
        }
      }
      if (!midWord && !next) {
        flushText(i);
        return mergeText(out);
      }
    }

    if (src[i] === "[") {
      const endLabel = findUnescaped(src, "]", i + 1);
      if (endLabel < 0) {
        flushText(i);
        out.push(...nested(i + 1));
        return mergeText(out);
      }
      if (src[endLabel + 1] === "(") {
        const endHref = findHrefClose(src, endLabel + 2);
        if (endHref < 0) {
          flushText(i);
          out.push(...nested(i + 1, endLabel));
          return mergeText(out);
        }
        const href = src.slice(endLabel + 2, endHref).trim();
        if (SAFE_HREF.test(href)) push({ kind: "a", href, children: nested(i + 1, endLabel) });
        else push({ kind: "text", text: src.slice(i + 1, endLabel) });
        i = endHref + 1;
        textStart = i;
        continue;
      }
    }

    i += 1;
  }

  flushText(src.length);
  return mergeText(out);
}

function headingLevel(line: string): number | null {
  const match = /^(#{1,6})[ \t]+(.*)$/.exec(line);
  return match ? match[1]!.length : null;
}

function headingText(line: string): string {
  return line.replace(/^#{1,6}[ \t]+/, "").replace(/[ \t]+#+\s*$/, "");
}

type ListRow = { indent: number; ordered: boolean; start: number; text: string };

function indentCols(prefix: string): number {
  let n = 0;
  for (const ch of prefix) n += ch === "\t" ? 2 : 1;
  return n;
}

function listRow(line: string): ListRow | null {
  const ul = /^([ \t]*)([-*+])[ \t]+(.*)$/.exec(line);
  if (ul) return { indent: indentCols(ul[1]!), ordered: false, start: 1, text: ul[3]! };
  const ol = /^([ \t]*)(\d+)\.[ \t]+(.*)$/.exec(line);
  if (ol) return { indent: indentCols(ol[1]!), ordered: true, start: Number(ol[2]), text: ol[3]! };
  return null;
}

function parseListAt(
  rows: ListRow[],
  startIndex: number,
  indent: number,
  isCited: IsCited,
): { block: Extract<StreamMdBlock, { kind: "ul" | "ol" }>; next: number } {
  const first = rows[startIndex]!;
  const ordered = first.ordered;
  const items: StreamMdListItem[] = [];
  let i = startIndex;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.indent < indent) break;
    if (row.indent > indent) {
      const inner = parseListAt(rows, i, row.indent, isCited);
      const last = items[items.length - 1];
      if (last) last.child = inner.block;
      else items.push({ inlines: [], child: inner.block });
      i = inner.next;
      continue;
    }
    if (row.ordered !== ordered) break;
    items.push({ inlines: parseInlines(row.text, isCited) });
    i += 1;
  }
  return { block: ordered ? { kind: "ol", items, start: first.start } : { kind: "ul", items }, next: i };
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && (t.startsWith("|") || /\|.+\|/.test(t));
}

function startsTable(lines: string[], i: number): boolean {
  return i + 1 < lines.length && isTableRow(lines[i]!) && isTableDivider(lines[i + 1]!);
}

function parseTableCells(line: string, isCited: IsCited): StreamMdInline[][] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => parseInlines(cell.trim(), isCited));
}

function quoteText(line: string): string | null {
  const match = /^>[ \t]?(.*)$/.exec(line);
  return match ? match[1]! : null;
}

function isHr(line: string): boolean {
  return /^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line);
}

function fenceOpen(line: string): string | null {
  const match = /^[ \t]*(```|~~~)([^`~]*)\s*$/.exec(line);
  return match ? (match[2] ?? "").trim() : null;
}

function fenceClose(line: string): boolean {
  return /^[ \t]*(```|~~~)[ \t]*$/.test(line);
}

export function parseStreamMarkdown(source: string, isCited: IsCited): StreamMdBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: StreamMdBlock[] = [];
  let i = 0;

  const takeParagraph = (first: string) => {
    const parts = [first];
    i += 1;
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim()) break;
      if (headingLevel(line) != null || listRow(line) || quoteText(line) != null) break;
      if (fenceOpen(line) != null || isHr(line) || startsTable(lines, i)) break;
      parts.push(line);
      i += 1;
    }
    blocks.push({ kind: "p", children: parseInlines(parts.join("\n"), isCited) });
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const lang = fenceOpen(line);
    if (lang != null) {
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !fenceClose(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: "pre", lang, text: body.join("\n") });
      continue;
    }

    if (isHr(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    const level = headingLevel(line);
    if (level != null) {
      blocks.push({ kind: "h", level, children: parseInlines(headingText(line), isCited) });
      i += 1;
      continue;
    }

    const firstList = listRow(line);
    if (firstList) {
      const rows: ListRow[] = [firstList];
      i += 1;
      while (i < lines.length) {
        const next = listRow(lines[i]!);
        if (!next) break;
        rows.push(next);
        i += 1;
      }
      let r = 0;
      while (r < rows.length) {
        const parsed = parseListAt(rows, r, rows[r]!.indent, isCited);
        blocks.push(parsed.block);
        r = parsed.next;
      }
      continue;
    }

    if (startsTable(lines, i)) {
      const headers = parseTableCells(line, isCited);
      i += 2;
      const rows: StreamMdInline[][][] = [];
      while (i < lines.length && isTableRow(lines[i]!) && !isTableDivider(lines[i]!)) {
        rows.push(parseTableCells(lines[i]!, isCited));
        i += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const quoted = quoteText(line);
    if (quoted != null) {
      const parts = [quoted];
      i += 1;
      while (i < lines.length) {
        const next = quoteText(lines[i]!);
        if (next == null) break;
        parts.push(next);
        i += 1;
      }
      blocks.push({ kind: "quote", children: parseInlines(parts.join("\n"), isCited) });
      continue;
    }

    takeParagraph(line);
  }

  return blocks;
}
