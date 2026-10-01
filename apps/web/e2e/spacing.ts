/**
 * GE9 (gates/leaf-GE9.md G2, G3): the 12 px rhythm of the stage chrome, measured on the page. `spacingPairs` runs in
 * the browser (pass it to `page.evaluate`) and returns every pair of neighbours it finds with the gap between them in
 * CSS px and where that gap lies; `offPairs` keeps the ones off the `--gap-m` unit by more than the tolerance;
 * `annotate` draws the gaps over the page for a screenshot.
 *
 * Desktop (stage layout): the chat card to the viewport's left, top and bottom edges; the chat card to the first
 * control of the top row (the app button) and to the timeline; the top row's controls to each other and to the top
 * edge; the top-right icon buttons to each other and to the top and right edges; the timeline to the bottom and
 * right edges; the bottom bar to the timeline and its items to each other; a right card (sighting, carp's sites
 * board, the lionfish survey) to the right edge, to the top row above it (the lowest of its controls and the icon
 * buttons) and to the timeline below it; GE8's zoom controls to their neighbours when they are on the page (skipped,
 * and said so, when they are not).
 * Phone (docks): the top row and the icon buttons to the top and side edges and to each other, the timeline to the
 * side edges and to the chat dock below it, and the bottom bar to the timeline.
 */
export const GAP_PX = 12;
export const TOLERANCE_PX = 0.5;

/** A measured gap: its size and the strip it spans (page px), for the annotated screenshot. */
export type Pair = { name: string; px: number; x1: number; y1: number; x2: number; y2: number };

/** In the page: the measured pairs, and notes (what was skipped). */
export function spacingPairs(): { pairs: Pair[]; notes: string[] } {
  const pairs: Pair[] = [];
  const notes: string[] = [];
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const shown = (el: Element | null | undefined): el is HTMLElement => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const box = (sel: string) => {
    const el = document.querySelector(sel);
    return shown(el) ? el.getBoundingClientRect() : null;
  };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  /** A horizontal gap from x1 to x2 at height y; a vertical one from y1 to y2 at x. */
  const h = (name: string, x1: number, x2: number, y: number) => pairs.push({ name, px: r2(x2 - x1), x1, x2, y1: y, y2: y });
  const v = (name: string, y1: number, y2: number, x: number) => pairs.push({ name, px: r2(y2 - y1), x1: x, x2: x, y1, y2 });
  const midX = (b: DOMRect) => b.left + b.width / 2;
  const midY = (b: DOMRect) => b.top + b.height / 2;
  const stage = document.querySelector("[data-shell]")?.getAttribute("data-layout") === "stage";
  const pane = document.querySelector('[data-slot="globe-pane"]')!.getBoundingClientRect();

  // Top row: its controls (the app button, the species chip) in order, then the icon buttons.
  const row = [...(document.querySelector('[data-testid="hud-toprow"]')?.children ?? [])].filter((el) => el.getAttribute("data-testid") !== "hud-topbar").filter(shown);
  const rowBoxes = row.map((el) => el.getBoundingClientRect());
  const buttons = [...(document.querySelector('[data-testid="hud-topbar"]')?.children ?? [])].filter(shown).map((el) => el.getBoundingClientRect());
  const timeline = box('[data-testid="hud-timeline"]') ?? box('[data-testid="carp-timeline"]');
  const bar = box('[data-testid="bottom-bar"]');
  const barItems = [...(document.querySelector('[data-testid="bottom-bar"]')?.children ?? [])].filter(shown).map((el) => el.getBoundingClientRect());

  if (rowBoxes[0]) v("top row: top edge to the app button", pane.top, rowBoxes[0].top, midX(rowBoxes[0]));
  for (let i = 1; i < rowBoxes.length; i++) {
    const b = rowBoxes[i]!;
    const a = rowBoxes[i - 1]!;
    // A narrow row wraps: the next control starts a new line, one gutter under the line above.
    if (b.left < a.right) v(`top row: line under control ${i} to control ${i + 1}`, Math.max(...rowBoxes.slice(0, i).map((r) => r.bottom)), b.top, midX(b));
    else h(`top row: control ${i} to control ${i + 1}`, a.right, b.left, midY(b));
  }
  if (buttons.length) {
    v("icon buttons: top edge", pane.top, buttons[0]!.top, midX(buttons[0]!));
    h("icon buttons: right edge", buttons.at(-1)!.right, vw, midY(buttons.at(-1)!));
    for (let i = 1; i < buttons.length; i++) h(`icon buttons: ${i} to ${i + 1}`, buttons[i - 1]!.right, buttons[i]!.left, midY(buttons[i]!));
  }
  if (timeline) {
    h("timeline: right edge", timeline.right, vw, midY(timeline));
    v(stage ? "timeline: bottom edge" : "timeline: chat dock below it", timeline.bottom, pane.bottom, midX(timeline));
  }
  if (bar && timeline) v("bottom bar: to the timeline", bar.bottom, timeline.top, midX(bar));
  for (let i = 1; i < barItems.length; i++) h(`bottom bar: item ${i} to item ${i + 1}`, barItems[i - 1]!.right, barItems[i]!.left, midY(barItems[i]!));

  if (stage) {
    const chat = box("[data-chat-column]");
    if (chat) {
      h("chat card: left edge", 0, chat.left, midY(chat));
      v("chat card: top edge", 0, chat.top, midX(chat));
      v("chat card: bottom edge", chat.bottom, vh, midX(chat));
      if (rowBoxes[0]) h("chat card to the app button", chat.right, rowBoxes[0].left, midY(rowBoxes[0]));
      if (timeline) h("chat card to the timeline", chat.right, timeline.left, midY(timeline));
    }
    const cardEl = ['[data-testid="hud-drawer"]', '[data-testid="carp-board-panel"]', '[data-testid="lionfish-panel"]', '[data-testid="carp-site-drawer"]'].map((s) => document.querySelector(s)).find(shown);
    const card = cardEl ? cardEl.getBoundingClientRect() : null;
    if (card) {
      h("right card: right edge", card.right, vw, midY(card));
      const above = [...rowBoxes, ...buttons].map((b) => b.bottom);
      if (above.length) v("right card: to the top row above it", Math.max(...above), card.top, midX(card));
      // A card capped at its own height (the lionfish survey) leaves the map below it: no neighbour there, unless the
      // cap is taller than the room and it reaches the timeline after all.
      const capped = cardEl?.hasAttribute("data-height-capped") ?? false;
      if (timeline && (!capped || timeline.top - card.bottom <= GAP_PX + 0.5)) v("right card: to the timeline below it", card.bottom, timeline.top, midX(card));
      else if (timeline) notes.push("right card stops at its own height, short of the timeline");
    } else notes.push("no right card open");
  } else {
    if (rowBoxes[0]) h("top row: left edge", pane.left, rowBoxes[0].left, midY(rowBoxes[0]));
    if (timeline) h("timeline: left edge", pane.left, timeline.left, midY(timeline));
  }

  // GE8's zoom controls (merged after this leaf): their outer box to the right edge and to the timeline.
  const zoom = [...document.querySelectorAll('[data-testid^="zoom-"]')].filter(shown).map((el) => el.getBoundingClientRect());
  if (zoom.length === 0) notes.push("zoom controls not on the page: zoom pairs skipped");
  else {
    const z = { left: Math.min(...zoom.map((b) => b.left)), top: Math.min(...zoom.map((b) => b.top)), right: Math.max(...zoom.map((b) => b.right)), bottom: Math.max(...zoom.map((b) => b.bottom)) };
    h("zoom: right edge", z.right, vw, (z.top + z.bottom) / 2);
    if (timeline) v("zoom: to the timeline", z.bottom, timeline.top, (z.left + z.right) / 2);
  }
  return { pairs, notes };
}

/** The pairs off the unit by more than the tolerance. */
export function offPairs(pairs: readonly Pair[]): Pair[] {
  return pairs.filter((p) => Math.abs(p.px - GAP_PX) > TOLERANCE_PX);
}

/** In the page: draw each gap as a marked strip with its size, over everything, for an annotated screenshot. */
export function annotate(pairs: readonly Pair[]): void {
  document.querySelector("[data-spacing-annotations]")?.remove();
  const layer = document.createElement("div");
  layer.dataset.spacingAnnotations = "";
  Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "2000", pointerEvents: "none" });
  for (const p of pairs) {
    const strip = document.createElement("div");
    const horizontal = p.y1 === p.y2;
    const ok = Math.abs(p.px - 12) <= 0.5;
    Object.assign(strip.style, {
      position: "absolute",
      left: `${Math.min(p.x1, p.x2) - (horizontal ? 0 : 3)}px`,
      top: `${Math.min(p.y1, p.y2) - (horizontal ? 3 : 0)}px`,
      width: `${horizontal ? Math.abs(p.x2 - p.x1) : 6}px`,
      height: `${horizontal ? 6 : Math.abs(p.y2 - p.y1)}px`,
      background: ok ? "rgba(0, 220, 255, 0.85)" : "rgba(255, 40, 40, 0.9)",
    });
    const label = document.createElement("span");
    label.textContent = String(Math.round(p.px * 10) / 10);
    Object.assign(label.style, { position: "absolute", left: horizontal ? "50%" : "8px", top: horizontal ? "8px" : "50%", transform: horizontal ? "translateX(-50%)" : "translateY(-50%)", font: "700 10px/1 monospace", color: "#00e0ff", textShadow: "0 0 2px #000, 0 0 2px #000" });
    strip.appendChild(label);
    layer.appendChild(strip);
  }
  document.body.appendChild(layer);
}
