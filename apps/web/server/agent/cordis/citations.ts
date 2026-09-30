/**
 * Streaming citation check (PRD §10 "Grounding"). The model cites with
 * `[e:<id>]`. A marker whose id a tool returned this turn passes through; any
 * other id is removed from the text. Markers can straddle stream chunks, so a
 * possible marker prefix is held back until it closes or cannot be a marker.
 */

const OPEN = "[e:";
/** Longest marker group we wait for before treating `[e:` as plain text. */
const MAX_MARKER_CHARS = 400;

export type CitationHooks = {
  isVerified(id: string): boolean;
  onVerified?(id: string): void;
  onUnverified?(id: string): void;
};

/** Ids inside one marker group: `[e:a]`, `[e:a, e:b]`, `[e:a; b]`. */
function idsIn(inner: string): string[] {
  return inner
    .split(/[,;\s]+/)
    .map((part) => part.trim().replace(/^e:/, ""))
    .filter((part) => part.length > 0);
}

export class CitationFilter {
  private pending = "";

  constructor(private readonly hooks: CitationHooks) {}

  /** Feed a delta; returns the text that is safe to emit now. */
  push(delta: string): string {
    let buf = this.pending + delta;
    this.pending = "";
    let out = "";
    while (buf.length > 0) {
      const at = buf.indexOf("[");
      if (at === -1) {
        out += buf;
        break;
      }
      out += buf.slice(0, at);
      const rest = buf.slice(at);
      if (rest.length < OPEN.length) {
        if (OPEN.startsWith(rest)) {
          this.pending = rest;
          break;
        }
        out += "[";
        buf = rest.slice(1);
        continue;
      }
      if (!rest.startsWith(OPEN)) {
        out += "[";
        buf = rest.slice(1);
        continue;
      }
      const close = rest.indexOf("]");
      const newline = rest.indexOf("\n");
      const unterminated = close === -1 || (newline !== -1 && newline < close);
      if (unterminated) {
        if (newline === -1 && rest.length <= MAX_MARKER_CHARS) {
          this.pending = rest;
          break;
        }
        out += "[";
        buf = rest.slice(1);
        continue;
      }
      out = this.resolveMarker(out, rest.slice(OPEN.length, close), rest.slice(close + 1));
      buf = rest.slice(close + 1);
    }
    return out;
  }

  /** End of stream: whatever is held back was not a marker. */
  flush(): string {
    const tail = this.pending;
    this.pending = "";
    return tail;
  }

  private resolveMarker(out: string, inner: string, after: string): string {
    const kept: string[] = [];
    for (const id of idsIn(inner)) {
      if (this.hooks.isVerified(id)) {
        kept.push(id);
        this.hooks.onVerified?.(id);
      } else {
        this.hooks.onUnverified?.(id);
      }
    }
    if (kept.length > 0) return out + kept.map((id) => `[e:${id}]`).join("");
    // Removing a whole marker: drop the space that preceded it before punctuation or a space.
    return out.endsWith(" ") && (after === "" || /^[\s.,;:!?)]/.test(after)) ? out.slice(0, -1) : out;
  }
}

/** One-shot form for final content. */
export function filterCitations(
  text: string,
  isVerified: (id: string) => boolean,
): { text: string; verified: string[]; unverified: string[] } {
  const verified: string[] = [];
  const unverified: string[] = [];
  const filter = new CitationFilter({
    isVerified,
    onVerified: (id) => verified.push(id),
    onUnverified: (id) => unverified.push(id),
  });
  return { text: filter.push(text) + filter.flush(), verified, unverified };
}

/** Every `[e:<id>]` id in a text, in order. */
export function citedIds(text: string): string[] {
  return [...text.matchAll(/\[e:([^\]\n]+)\]/g)].flatMap((match) => idsIn(match[1]!));
}
