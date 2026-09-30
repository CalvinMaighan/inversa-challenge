// src/dom/bind.ts
import { set as set2, subscribe } from "@calvinjs/active-state";

// src/dom/command.ts
import { get, set } from "@calvinjs/active-state";

// src/dom/path.ts
function parsePath(spec) {
  const [key, ...fields] = spec.split(".").filter(Boolean);
  if (!key) {
    throw new Error(`[active-state] Invalid path "${spec}".`);
  }
  return { key, fields };
}
function readPath(value, fields) {
  let current = value;
  for (const field of fields) {
    if (current == null || typeof current !== "object") return void 0;
    current = current[field];
  }
  return current;
}
function isIndex(field) {
  return /^\d+$/.test(field);
}
function writePath(value, fields, nextFieldValue) {
  if (fields.length === 0) return nextFieldValue;
  const [head, ...rest] = fields;
  if (head == null) return nextFieldValue;
  if (isIndex(head) || Array.isArray(value)) {
    const list = Array.isArray(value) ? value.slice() : [];
    const idx = Number(head);
    list[idx] = rest.length === 0 ? nextFieldValue : writePath(list[idx], rest, nextFieldValue);
    return list;
  }
  const base = value != null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  base[head] = rest.length === 0 ? nextFieldValue : writePath(base[head], rest, nextFieldValue);
  return base;
}

// src/dom/scope.ts
function resolvePath(spec, scope = []) {
  const parts = spec.split(".").filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`[active-state] Invalid path "${spec}".`);
  }
  const head = parts[0];
  for (let i = scope.length - 1; i >= 0; i--) {
    const frame = scope[i];
    if (frame.name === head) {
      return {
        key: frame.key,
        fields: [...frame.fields, ...parts.slice(1)]
      };
    }
  }
  return parsePath(spec);
}

// src/dom/command.ts
var VERBS = /* @__PURE__ */ new Set(["toggle", "set", "push", "remove", "move"]);
function parseCommand(spec) {
  const trimmed = spec.trim();
  const arrow = trimmed.match(/^(move)(?:→|>)(.+)$/);
  if (arrow) {
    const path2 = arrow[2].trim();
    if (!path2) {
      throw new Error(`[active-state] move requires a destination path.`);
    }
    return { verb: "move", path: path2 };
  }
  const first = trimmed.indexOf(":");
  if (first === -1) {
    throw new Error(
      `[active-state] Invalid command "${spec}". Use verb:path (e.g. toggle:LAYOUT.nav).`
    );
  }
  const verb = trimmed.slice(0, first);
  let rest = trimmed.slice(first + 1);
  if (!VERBS.has(verb)) {
    throw new Error(
      `[active-state] Unknown verb "${verb}". Use toggle|set|push|remove|move.`
    );
  }
  if (verb === "toggle" || verb === "remove") {
    if (!rest) throw new Error(`[active-state] ${verb} requires a path.`);
    return { verb, path: rest };
  }
  if (verb === "move") {
    rest = rest.replace(/^\u2192/, "").replace(/^→/, "").replace(/^>/, "");
    if (!rest) {
      throw new Error(`[active-state] move requires a destination path.`);
    }
    return { verb: "move", path: rest };
  }
  const second = rest.indexOf(":");
  if (second === -1) {
    if (verb === "push") {
      return { verb: "push", path: rest, payload: void 0 };
    }
    throw new Error(`[active-state] set requires verb:path:value.`);
  }
  const path = rest.slice(0, second);
  const raw = rest.slice(second + 1);
  return { verb, path, payload: parsePayload(raw) };
}
function parsePayload(raw) {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t !== "" && !Number.isNaN(Number(t)) && /^-?\d+(\.\d+)?$/.test(t)) {
    return Number(t);
  }
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
function runCommand(command, scope, extras) {
  const resolved = resolvePath(command.path, scope);
  if (command.verb === "toggle") {
    set(resolved.key, (prev) => {
      if (resolved.fields.length === 0) return !prev;
      const current = readPath(prev, resolved.fields);
      return writePath(prev, resolved.fields, !current);
    });
    return;
  }
  if (command.verb === "set") {
    set(
      resolved.key,
      (prev) => resolved.fields.length === 0 ? command.payload : writePath(prev, resolved.fields, command.payload)
    );
    return;
  }
  if (command.verb === "push") {
    const item = command.payload !== void 0 ? command.payload : extras?.formRecord ?? {};
    set(resolved.key, (prev) => {
      const arr = resolved.fields.length === 0 ? prev : readPath(prev, resolved.fields);
      const list = Array.isArray(arr) ? arr.slice() : [];
      list.push(item);
      return resolved.fields.length === 0 ? list : writePath(prev, resolved.fields, list);
    });
    return;
  }
  if (command.verb === "remove") {
    set(resolved.key, (prev) => {
      if (resolved.fields.length === 0) return void 0;
      const parentFields = resolved.fields.slice(0, -1);
      const last = resolved.fields[resolved.fields.length - 1];
      const parent = parentFields.length ? readPath(prev, parentFields) : prev;
      if (Array.isArray(parent)) {
        const next = parent.slice();
        const idx = Number(last);
        if (!Number.isNaN(idx)) next.splice(idx, 1);
        return parentFields.length ? writePath(prev, parentFields, next) : next;
      }
      if (parent != null && typeof parent === "object") {
        const next = { ...parent };
        delete next[last];
        return parentFields.length ? writePath(prev, parentFields, next) : next;
      }
      return prev;
    });
    return;
  }
  if (command.verb === "move") {
    const id = extras?.dragId;
    if (id == null || id === "") return;
    set(
      resolved.key,
      (prev) => moveIdToArray(prev, String(id), resolved.fields)
    );
  }
}
function moveIdToArray(value, id, destFields) {
  const removed = removeByIdShared(value, id);
  if (removed.found == null) return value;
  if (destFields.length === 0) {
    const list2 = Array.isArray(removed.next) ? removed.next.slice() : [];
    list2.push(removed.found);
    return list2;
  }
  const arr = readPath(removed.next, destFields);
  const list = Array.isArray(arr) ? arr.slice() : [];
  list.push(removed.found);
  return writePath(removed.next, destFields, list);
}
function removeByIdShared(node, id) {
  if (Array.isArray(node)) {
    const idx = node.findIndex(
      (item) => item != null && typeof item === "object" && item.id === id
    );
    if (idx !== -1) {
      const found2 = node[idx];
      return {
        found: found2,
        next: [...node.slice(0, idx), ...node.slice(idx + 1)]
      };
    }
    let found = null;
    let changed = false;
    const next = node.map((item) => {
      if (found != null) return item;
      const nested = removeByIdShared(item, id);
      if (nested.found != null) {
        found = nested.found;
        changed = true;
        return nested.next;
      }
      return item;
    });
    return { next: changed ? next : node, found };
  }
  if (node != null && typeof node === "object") {
    const obj = node;
    for (const key of Object.keys(obj)) {
      const nested = removeByIdShared(obj[key], id);
      if (nested.found != null) {
        return {
          found: nested.found,
          next: { ...obj, [key]: nested.next }
        };
      }
    }
  }
  return { next: node, found: null };
}
function readAt(scope, path) {
  const { key, fields } = resolvePath(path, scope);
  const value = get(key);
  return fields.length ? readPath(value, fields) : value;
}

// src/dom/bind.ts
var activeGhost = null;
var stopGhostFollow = null;
var transparentDragPixel = null;
function getTransparentDragPixel() {
  if (typeof Image === "undefined") return null;
  if (!transparentDragPixel) {
    transparentDragPixel = new Image();
    transparentDragPixel.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  }
  return transparentDragPixel;
}
function clearDragUi(root = document) {
  if (typeof document !== "undefined") {
    document.documentElement.classList.remove("is-dragging");
  }
  stopGhostFollow?.();
  stopGhostFollow = null;
  activeGhost?.remove();
  activeGhost = null;
  const scope = root instanceof Element || root instanceof Document ? root : document;
  if (typeof scope.querySelectorAll !== "function") return;
  scope.querySelectorAll(".dragging").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    node.classList.remove("dragging");
    node.style.removeProperty("--tilt");
    node.style.removeProperty("--lift");
  });
}
function startTiltedGhost(event, el, tiltDeg) {
  const dt = event.dataTransfer;
  if (!dt) return;
  const rect = el.getBoundingClientRect();
  const offsetX = event.clientX - rect.left;
  const offsetY = event.clientY - rect.top;
  stopGhostFollow?.();
  activeGhost?.remove();
  const ghost = el.cloneNode(true);
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
    transition: "none"
  });
  const place = (x, y) => {
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
    sink.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0";
    document.body.appendChild(sink);
    dt.setDragImage(sink, 0, 0);
    setTimeout(() => sink.remove(), 0);
  }
  const onDragOver = (e) => {
    if (e.clientX === 0 && e.clientY === 0) return;
    place(e.clientX, e.clientY);
  };
  document.addEventListener("dragover", onDragOver, true);
  stopGhostFollow = () => {
    document.removeEventListener("dragover", onDragOver, true);
  };
}
function bind(root = document) {
  const cleanups = [];
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
function bindTree(root, scope, cleanups) {
  const elements = [];
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
    bindElement(el, scope, cleanups);
  }
}
function bindElement(el, scope, cleanups) {
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
    const command = parseCommand(spec);
    const onClick = () => {
      runCommand(command, scope);
    };
    el.addEventListener("click", onClick);
    cleanups.push(() => el.removeEventListener("click", onClick));
  }
  const submit = el.getAttribute("active-submit");
  if (submit && el instanceof HTMLFormElement) {
    const command = parseCommand(submit);
    const onSubmit = (event) => {
      event.preventDefault();
      const form = event.target;
      const record = Object.fromEntries(new FormData(form).entries());
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
    const onStart = (event) => {
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
      drop.startsWith("move") ? drop : `move\u2192${drop}`
    );
    const onOver = (event) => {
      event.preventDefault();
      el.classList.add("drag-over");
    };
    const onLeave = () => el.classList.remove("drag-over");
    const onDrop = (event) => {
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
function bindModel(el, spec, scope, cleanups) {
  const write = (next) => {
    const { key, fields } = resolvePath(spec, scope);
    set2(
      key,
      (prev) => fields.length === 0 ? next : writePath(prev, fields, next)
    );
  };
  const apply = () => {
    const value = readAt(scope, spec);
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox") el.checked = Boolean(value);
      else el.value = value == null ? "" : String(value);
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      el.value = value == null ? "" : String(value);
    }
  };
  watchPath(spec, scope, apply, cleanups);
  const onInput = () => {
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      write(el.checked);
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
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
function eachItemKey(item, index) {
  if (item != null && typeof item === "object" && "id" in item && item.id != null) {
    return String(item.id);
  }
  return `#${index}`;
}
function bindEach(template, scope, cleanups) {
  const listPath = template.getAttribute("active-each");
  const as = template.getAttribute("active-as");
  if (!listPath || !as) {
    throw new Error(
      '[active-state] active-each requires active-as="alias" on <template>.'
    );
  }
  let prevList = /* @__PURE__ */ Symbol("active-each-unset");
  let blocks = [];
  const unmountBlock = (block) => {
    for (const stop of block.cleanups) stop();
    for (const node of block.nodes) node.parentNode?.removeChild(node);
  };
  const mountBlock = (item, index, storeKey, fields) => {
    const frame = {
      name: as,
      key: storeKey,
      fields: [...fields, String(index)]
    };
    const childScope = [...scope, frame];
    const fragment = template.content.cloneNode(true);
    const blockCleanups = [];
    const nodes = [...fragment.childNodes];
    bindTree(fragment, childScope, blockCleanups);
    for (const node of nodes) {
      if (node instanceof HTMLElement) node.classList.add("each-enter");
      template.parentNode?.insertBefore(node, template);
    }
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
      cleanups: blockCleanups
    };
  };
  const clear = () => {
    for (const block of blocks) unmountBlock(block);
    blocks = [];
    prevList = /* @__PURE__ */ Symbol("active-each-unset");
  };
  const render = () => {
    const list = readAt(scope, listPath);
    if (Object.is(list, prevList)) return;
    prevList = list;
    const items = Array.isArray(list) ? list : [];
    const { key: storeKey, fields } = resolvePath(listPath, scope);
    const parent = template.parentNode;
    if (!parent) return;
    const prevByKey = new Map(blocks.map((block) => [block.key, block]));
    const nextBlocks = [];
    const used = /* @__PURE__ */ new Set();
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
    let anchor = template;
    for (let i = nextBlocks.length - 1; i >= 0; i--) {
      const nodes = nextBlocks[i].nodes;
      for (let j = nodes.length - 1; j >= 0; j--) {
        const node = nodes[j];
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
function watchPath(spec, scope, render, cleanups) {
  const { key } = resolvePath(spec, scope);
  render();
  cleanups.push(subscribe(key, () => render()));
}
export {
  bind,
  moveIdToArray,
  parseCommand,
  parsePath,
  readPath,
  resolvePath,
  runCommand,
  writePath
};
