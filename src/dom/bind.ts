import { set, subscribe } from "active-state";
import { parseCommand, readAt, runCommand } from "./command";
import { writePath } from "./path";
import { resolvePath, type Scope } from "./scope";

type Cleanup = () => void;

/** Live ghost — Chromium’s setDragImage bitmap ignores CSS transforms. */
let activeGhost: HTMLElement | null = null;
let stopGhostFollow: (() => void) | null = null;
let transparentDragPixel: HTMLImageElement | null = null;

/** Invisible drag bitmap. Avoids the empty-image icon from a blank canvas. */
function getTransparentDragPixel(): HTMLImageElement | null {
  if (typeof Image === "undefined") return null;
  if (!transparentDragPixel) {
    transparentDragPixel = new Image();
    transparentDragPixel.src =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  }
  return transparentDragPixel;
}

/** Drop remounts `active-each` and can remove the source before `dragend` fires. */
function clearDragUi(root: ParentNode = document): void {
  if (typeof document !== "undefined") {
    document.documentElement.classList.remove("is-dragging");
  }
  stopGhostFollow?.();
  stopGhostFollow = null;
  activeGhost?.remove();
  activeGhost = null;

  const scope =
    root instanceof Element || root instanceof Document
      ? root
      : document;
  if (typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll(".dragging").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    node.classList.remove("dragging");
    node.style.removeProperty("--tilt");
    node.style.removeProperty("--lift");
  });
}

/**
 * Skeleton the source in place; float a tilted clone that follows the pointer.
 * setDragImage gets a transparent pixel only (browser bitmaps drop CSS rotate).
 */
function startTiltedGhost(
  event: DragEvent,
  el: HTMLElement,
  tiltDeg: number,
): void {
  const dt = event.dataTransfer;
  if (!dt) return;

  const rect = el.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;

  stopGhostFollow?.();
  activeGhost?.remove();

  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("active-drag");
  ghost.removeAttribute("draggable");
  ghost.classList.remove("dragging");
  ghost.classList.add("drag-ghost");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: `${Math.max(rect.width, 1)}px`,
    height: `${Math.max(rect.height, 1)}px`,
    margin: "0",
    boxSizing: "border-box",
    transformOrigin: "center center",
    pointerEvents: "none",
    zIndex: "10000",
    transition: "none",
  });
  const place = (x: number, y: number) => {
    ghost.style.transform = `translate(${x - offsetX}px, ${y - offsetY}px) rotate(${tiltDeg}deg) scale(1.06)`;
  };
  place(event.clientX, event.clientY);
  document.body.appendChild(ghost);
  activeGhost = ghost;

  const pixel = getTransparentDragPixel();
  if (pixel?.complete) {
    dt.setDragImage(pixel, 0, 0);
  } else {
    const sink = document.createElement("div");
    sink.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0";
    document.body.appendChild(sink);
    dt.setDragImage(sink, 0, 0);
    setTimeout(() => sink.remove(), 0);
  }

  const onDragOver = (e: DragEvent) => {
    if (e.clientX === 0 && e.clientY === 0) return;
    place(e.clientX, e.clientY);
  };
  document.addEventListener("dragover", onDragOver, true);
  stopGhostFollow = () => {
    document.removeEventListener("dragover", onDragOver, true);
  };
}

/**
 * Path + verb DOM bindings (no expression JS, no components).
 *
 * | Attr | Role |
 * | --- | --- |
 * | `active-text` | textContent ← path |
 * | `active-show` | display ← truthy path |
 * | `active-model` | two-way input/checkbox/select |
 * | `active-click` | `toggle:path` / `set:path:value` / … |
 * | `active-toggle` | shorthand for `toggle:path` |
 * | `active-submit` | form → `push:path` (FormData as object) |
 * | `active-each` + `active-as` | `<template>` list |
 * | `active-drag` | drag payload ← path (e.g. `card.id`) |
 * | `active-drop` | `move→arrayPath` on drop |
 */
export function bind(root: ParentNode = document): () => void {
  const cleanups: Cleanup[] = [];
  // Capture phase so we still clear UI if the drag source was remounted on drop.
  const onDocDragEnd = () => clearDragUi(root);
  document.addEventListener("dragend", onDocDragEnd, true);
  document.addEventListener("drop", onDocDragEnd, true);
  cleanups.push(() => {
    document.removeEventListener("dragend", onDocDragEnd, true);
    document.removeEventListener("drop", onDocDragEnd, true);
  });
  bindTree(root, [], cleanups);
  return () => {
    for (const stop of cleanups) stop();
  };
}

function bindTree(root: ParentNode, scope: Scope, cleanups: Cleanup[]): void {
  const elements: Element[] = [];
  if (root instanceof Element) elements.push(root);
  if (typeof root.querySelectorAll === "function") {
    root.querySelectorAll("*").forEach((el) => elements.push(el));
  }

  for (const el of elements) {
    if (el instanceof HTMLTemplateElement && el.hasAttribute("active-each")) {
      bindEach(el, scope, cleanups);
    }
  }

  for (const el of elements) {
    if (el instanceof HTMLTemplateElement) continue;
    if (typeof el.closest === "function" && el.closest("template")) continue;
    bindElement(el as HTMLElement, scope, cleanups);
  }
}

function bindElement(el: HTMLElement, scope: Scope, cleanups: Cleanup[]): void {
  const text = el.getAttribute("active-text");
  if (text) {
    const render = () => {
      const value = readAt(scope, text);
      el.textContent = value == null ? "" : String(value);
    };
    watchPath(text, scope, render, cleanups);
  }

  const show = el.getAttribute("active-show");
  if (show) {
    const render = () => {
      const value = readAt(scope, show);
      el.style.display = value ? "" : "none";
    };
    watchPath(show, scope, render, cleanups);
  }

  const model = el.getAttribute("active-model");
  if (model) bindModel(el, model, scope, cleanups);

  const clickRaw = el.getAttribute("active-click");
  const toggleRaw = el.getAttribute("active-toggle");
  if (clickRaw || toggleRaw) {
    const spec = clickRaw ?? `toggle:${toggleRaw}`;
    const command = parseCommand(spec!);
    const onClick = () => {
      runCommand(command, scope);
    };
    el.addEventListener("click", onClick);
    cleanups.push(() => el.removeEventListener("click", onClick));
  }

  const submit = el.getAttribute("active-submit");
  if (submit && el instanceof HTMLFormElement) {
    const command = parseCommand(submit);
    const onSubmit = (event: Event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const record = Object.fromEntries(new FormData(form).entries()) as Record<
        string,
        string
      >;
      if (command.verb === "push" && record.title && !record.id) {
        record.id = `c_${Date.now().toString(36)}`;
      }
      runCommand(command, scope, { formRecord: record });
      form.reset();
    };
    el.addEventListener("submit", onSubmit);
    cleanups.push(() => el.removeEventListener("submit", onSubmit));
  }

  const drag = el.getAttribute("active-drag");
  if (drag) {
    el.draggable = true;
    const onStart = (event: DragEvent) => {
      const value = readAt(scope, drag);
      const dt = event.dataTransfer;
      if (!dt) return;
      dt.setData("text/plain", String(value ?? ""));
      dt.effectAllowed = "move";

      const rect = el.getBoundingClientRect();
      const ox = event.clientX - (rect.left + rect.width / 2);
      const tilt = Math.max(-14, Math.min(14, ox / 6));
      startTiltedGhost(event, el, tilt);
      el.classList.add("dragging");
      document.documentElement.classList.add("is-dragging");
    };
    const onEnd = () => clearDragUi();
    el.addEventListener("dragstart", onStart);
    el.addEventListener("dragend", onEnd);
    cleanups.push(() => {
      el.removeEventListener("dragstart", onStart);
      el.removeEventListener("dragend", onEnd);
    });
  }

  const drop = el.getAttribute("active-drop");
  if (drop) {
    const command = parseCommand(
      drop.startsWith("move") ? drop : `move→${drop}`,
    );
    const onOver = (event: DragEvent) => {
      event.preventDefault();
      el.classList.add("drag-over");
    };
    const onLeave = () => el.classList.remove("drag-over");
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      el.classList.remove("drag-over");
      const dragId = event.dataTransfer?.getData("text/plain");
      runCommand(command, scope, { dragId });
      clearDragUi();
    };
    el.addEventListener("dragover", onOver);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDrop);
    cleanups.push(() => {
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDrop);
    });
  }
}

function bindModel(
  el: HTMLElement,
  spec: string,
  scope: Scope,
  cleanups: Cleanup[],
): void {
  const write = (next: unknown) => {
    const { key, fields } = resolvePath(spec, scope);
    set(key, (prev) =>
      fields.length === 0 ? next : writePath(prev, fields, next),
    );
  };

  const apply = () => {
    const value = readAt(scope, spec);
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox") el.checked = Boolean(value);
      else el.value = value == null ? "" : String(value);
    } else if (
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      el.value = value == null ? "" : String(value);
    }
  };

  watchPath(spec, scope, apply, cleanups);

  const onInput = () => {
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      write(el.checked);
    } else if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      write(el.value);
    }
  };

  el.addEventListener("input", onInput);
  el.addEventListener("change", onInput);
  cleanups.push(() => {
    el.removeEventListener("input", onInput);
    el.removeEventListener("change", onInput);
  });
}

type EachBlock = {
  key: string;
  item: unknown;
  index: number;
  frame: { name: string; key: string; fields: string[] };
  nodes: ChildNode[];
  cleanups: Cleanup[];
};

function eachItemKey(item: unknown, index: number): string {
  if (
    item != null &&
    typeof item === "object" &&
    "id" in item &&
    (item as { id: unknown }).id != null
  ) {
    return String((item as { id: unknown }).id);
  }
  return `#${index}`;
}

function bindEach(
  template: HTMLTemplateElement,
  scope: Scope,
  cleanups: Cleanup[],
): void {
  const listPath = template.getAttribute("active-each");
  const as = template.getAttribute("active-as");
  if (!listPath || !as) {
    throw new Error(
      '[active-state] active-each requires active-as="alias" on <template>.',
    );
  }

  let prevList: unknown = Symbol("active-each-unset");
  let blocks: EachBlock[] = [];

  const unmountBlock = (block: EachBlock) => {
    for (const stop of block.cleanups) stop();
    for (const node of block.nodes) node.parentNode?.removeChild(node);
  };

  const mountBlock = (
    item: unknown,
    index: number,
    storeKey: string,
    fields: string[],
  ): EachBlock => {
    const frame = {
      name: as,
      key: storeKey,
      fields: [...fields, String(index)],
    };
    const childScope: Scope = [...scope, frame];
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const blockCleanups: Cleanup[] = [];
    const nodes = [...fragment.childNodes];
    bindTree(fragment, childScope, blockCleanups);
    for (const node of nodes) {
      if (node instanceof HTMLElement) node.classList.add("each-enter");
      template.parentNode?.insertBefore(node, template);
    }
    // Drop enter class after first paint so later moves don't re-animate.
    queueMicrotask(() => {
      for (const node of nodes) {
        if (node instanceof HTMLElement) node.classList.remove("each-enter");
      }
    });
    return {
      key: eachItemKey(item, index),
      item,
      index,
      frame,
      nodes,
      cleanups: blockCleanups,
    };
  };

  const clear = () => {
    for (const block of blocks) unmountBlock(block);
    blocks = [];
    prevList = Symbol("active-each-unset");
  };

  const render = () => {
    const list = readAt(scope, listPath);
    // Same array reference → nothing in this list changed (structural sharing).
    if (Object.is(list, prevList)) return;
    prevList = list;

    const items = Array.isArray(list) ? list : [];
    const { key: storeKey, fields } = resolvePath(listPath, scope);
    const parent = template.parentNode;
    if (!parent) return;

    const prevByKey = new Map(blocks.map((block) => [block.key, block]));
    const nextBlocks: EachBlock[] = [];
    const used = new Set<string>();

    // Update scope frames before any DOM work so sibling text bindings that
    // fire in the same notify pass don't read stale indexes (empty titles).
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const key = eachItemKey(item, index);
      const existing = prevByKey.get(key);
      if (existing && !used.has(key)) {
        existing.frame.fields = [...fields, String(index)];
        existing.index = index;
        existing.item = item;
      }
    }

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const key = eachItemKey(item, index);
      const existing = prevByKey.get(key);

      if (existing && !used.has(key)) {
        used.add(key);
        nextBlocks.push(existing);
        continue;
      }

      nextBlocks.push(mountBlock(item, index, storeKey, fields));
    }

    const kept = new Set(nextBlocks);
    for (const block of blocks) {
      if (!kept.has(block)) unmountBlock(block);
    }

    // Only move nodes that are out of order — re-inserting retriggers
    // @starting-style and makes siblings look empty/collapsed.
    let anchor: ChildNode | Node = template;
    for (let i = nextBlocks.length - 1; i >= 0; i--) {
      const nodes = nextBlocks[i]!.nodes;
      for (let j = nodes.length - 1; j >= 0; j--) {
        const node = nodes[j]!;
        if (node.nextSibling !== anchor) {
          parent.insertBefore(node, anchor);
        }
        anchor = node;
      }
    }

    blocks = nextBlocks;
  };

  watchPath(listPath, scope, render, cleanups);
  cleanups.push(clear);
}

function watchPath(
  spec: string,
  scope: Scope,
  render: () => void,
  cleanups: Cleanup[],
): void {
  const { key } = resolvePath(spec, scope);
  render();
  cleanups.push(subscribe(key, () => render()));
}
