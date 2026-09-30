# active-state

Tiny keyed pub/sub store for shared client UI state — React, Next.js, Astro, HTMX, and light static HTML.

No Providers. Theme-agnostic (bring your own keys).

## Install

```bash
bunx add @calvinjs/active-state
```

## 1. Define keys

`key()` types the id **and** registers its defaults on `ActiveState.state`.

```ts
// client/state/user.ts
import { key } from "@calvinjs/active-state";

export const USER = key("USER", {
  id: null as string | null,
  name: null as string | null,
});
```

```ts
// client/state/layout.ts
import { key } from "@calvinjs/active-state";

export const LAYOUT = key("LAYOUT", { nav: false });
```

```ts
// client/state/theme.ts
import { key } from "@calvinjs/active-state";

// Survives refresh (localStorage). With <ActiveState init={state} ssr />, applies after first paint.
export const THEME = key("THEME", { dark: false }, { persist: true });
```

```ts
// client/state/index.ts
import { catalog } from "@calvinjs/active-state";
import { USER } from "./user";
import { LAYOUT } from "./layout";
import { THEME } from "./theme";

export { USER, LAYOUT, THEME };

/** Snapshot for `<ActiveState init={state} />` — importing this runs every `key()`. */
export const state = catalog(USER, LAYOUT, THEME);
```

```ts
// client/index.ts — barrel for the whole client folder
export * from "./state";
```

Keys should be `UPPERCASE_IDS` unless you pass `{ any: true }`.

- `LAYOUT.$` → `"LAYOUT"`
- `LAYOUT.nav` → `"LAYOUT.nav"`
- `state` / `ActiveState.state` → `{ USER: {…}, LAYOUT: { nav: false }, THEME: {…} }`

Path alias — point at the `client` folder:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "client": ["./client"],
      "client/*": ["./client/*"]
    }
  }
}
```

```ts
import { state, USER, LAYOUT } from "client";
import { LAYOUT } from "client/state/layout"; // single key module
```

Next.js picks up `paths` from `tsconfig.json` automatically.

## 2. Init once

`<ActiveState init={…} />` is **required**. Import your catalog and pass the snapshot — that import is what runs `key()` (persist marks, registry) and makes the map you hand to boot.

Don’t mount `<ActiveState />` from a lazy route that defines keys later — `init` is idempotent and will not pick up keys registered after the first boot.

### Next.js / React

```tsx
// app/layout.tsx
import { state } from "client/state";
import { ActiveState } from "@calvinjs/active-state/react";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ActiveState init={state} ssr />
        {children}
      </body>
    </html>
  );
}
```

| Prop | Meaning |
| --- | --- |
| `init` | **Required.** Non-empty map (usually `state` from your catalog). |
| `ssr` | App Router / static export — safe hydration. |
| `any` | Allow non-`UPPERCASE_IDS` keys. |

Same-file / one-off apps can pass the live registry:

```tsx
<ActiveState init={ActiveState.state} />
```

Client-only apps can omit `ssr`:

```tsx
import { state } from "client/state";
<ActiveState init={state} />
```

### Without React

```ts
import { state } from "client/state";
import { init } from "@calvinjs/active-state";

init(state);
// init(state, { ssr: true })
```

## 3. Use it in React

```tsx
// components/nav-toggle.tsx
"use client";

import { useActiveState } from "@calvinjs/active-state/react";
import { LAYOUT } from "client";


export function NavToggle() {
  const [layout, setLayout] = useActiveState<typeof LAYOUT.defaults>(LAYOUT);

  return (
    <button
      type="button"
      onClick={() => setLayout((l) => ({ ...l!, nav: !l?.nav }))}
    >
      {layout?.nav ? "Close" : "Menu"}
    </button>
  );
}
```

```ts
ActiveState.set(LAYOUT, (l) => ({ ...l!, nav: true }));
ActiveState.get(LAYOUT);
```

## 4. Public / static HTML

Paths + verbs in HTML — **no JS expressions** (not Alpine). Keep attr strings aligned with your `key()` paths.

```html
<script src="https://unpkg.com/@calvinjs/active-state/dist/active-state.min.js"></script>
<script>
  ActiveState.init({ LAYOUT: { nav: false }, THEME: { dark: false } });
  ActiveState.bind();
</script>

<button type="button" active-click="toggle:LAYOUT.nav">Menu</button>
Nav: <span active-text="LAYOUT.nav"></span>

<input active-model="THEME.label" />
<template active-each="BOARD.columns" active-as="col">
  <section active-drop="move→col.cards">
    <h2 active-text="col.title"></h2>
    <template active-each="col.cards" active-as="card">
      <article active-drag="card.id">
        <span active-text="card.title"></span>
      </article>
    </template>
    <form active-submit="push:col.cards">
      <input name="title" />
      <button type="submit">Add</button>
    </form>
  </section>
</template>
```

| Attribute | Behavior |
| --- | --- |
| `active-text` | `textContent` ← path |
| `active-show` | show when path is truthy |
| `active-model` | two-way on input/textarea/select/checkbox |
| `active-click` | command: `toggle:path`, `set:path:value`, `push:path:json` |
| `active-toggle` | shorthand → `toggle:path` |
| `active-submit` | form → `push:path` (FormData object; auto `id` if `title` set) |
| `active-each` + `active-as` | `<template>` list; alias paths like `col.title` |
| `active-drag` | drag payload ← path (e.g. `card.id`) |
| `active-drop` | `move→arrayPath` moves `{id}` into that array |

See `examples/html` for a full kanban.

With a bundler:

```ts
import "client";
import { init, registeredState } from "@calvinjs/active-state";
import { bind } from "@calvinjs/active-state/dom";

init(registeredState());
bind();
```

## 5. ESLint (agent guardrails)

Errors include fix instructions so coding agents self-correct.

```bash
bunx add -d eslint @calvinjs/active-state
```

```js
// eslint.config.mjs
import { recommended, publicPages } from "@calvinjs/active-state/eslint";

export default [
  ...recommended,
  // Hook ban on public/marketing only — omit authenticated app routes.
  ...publicPages({
    files: [
      "app/(public)/**/*.{js,jsx,ts,tsx}",
      "app/(marketing)/**/*.{js,jsx,ts,tsx}",
    ],
  }),
];
```

| Rule | Catches |
| --- | --- |
| `no-string-keys` | `get("LAYOUT")` / `useActiveState("…")` — use a `key()` slice |
| `valid-active-attr` | Bad `active-*` path / command shape |
| `no-hooks-in-files` | Any React hook under your `publicPages` globs |

`recommended` = string keys + attr shape. `publicPages({ files })` = hook ban on those paths only — list public/marketing globs; leave `app/(app)/**` (or whatever your product shell is) out so agents can use hooks there.

## 6. Threads (`@calvinjs/active-state/threads`)

Run the same store on the main thread and in Web Workers. `set` on one thread lands in the other thread's store, where `subscribe` and `useActiveState` fire as usual. The public `key / get / set / subscribe` API does not change.

```ts
// main thread
import { catalog, init } from "@calvinjs/active-state";
import { hostThread } from "@calvinjs/active-state/threads";

const state = catalog(TIME, VIEW, LAYERS);
init(state);
const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });
const link = hostThread(worker, state);
// later: link.close()
```

```ts
// db.worker.ts — call at the top level, before the first await
import { set, subscribe } from "@calvinjs/active-state";
import { connectThread } from "@calvinjs/active-state/threads";

const link = connectThread(self, state); // calls init(state) when needed
subscribe(TIME, (t) => set(FRAMES_READY, computeFrames(t)));
```

How it works:

- **Key index.** Each key's index is its position in the sorted id list of the catalog (`keyIndexTable(state)`). Both threads must pass the same catalog; the host's table wins on mismatch.
- **Transport.** `createChannel()` picks a `SharedArrayBuffer` pair when `crossOriginIsolated` (or outside browsers) and a `MessageChannel` otherwise; both implement `Transport { send, onMessage, close }`. Pass `{ transport: "message" }` to force the fallback.
- **Ring.** One SPSC byte ring per direction: an `Int32Array[2 + 256]` control block (`writeCursor`, `readCursor`, one version per key index) and a power-of-2 data region of `u16 keyIndex, u32 len, UTF-8 JSON` records. A record never straddles the wrap: a `0xFFFF` pad marker sends the reader back to 0. Writers `Atomics.notify`; readers use `Atomics.waitAsync` where available and sliced `Atomics.wait` in workers without it. A full ring queues in the sender (backpressure, never overwrites). The default 2 MiB ring takes values up to 1 MB; larger values throw, so raise `capacity` instead of chunking.
- **No echo.** A value applied from the other thread is not sent back. With several workers, main fans a worker's `set` out to the others.
- **Snapshot.** `hostThread` sends every catalog value on connect (`snapshot: false` to skip). Values must be JSON-serializable.
- **Ordering** is per key and, in practice, global per direction.

Bulk data stays out of the ring. `allocFrameGrid({ frameCount, cols, rows, speciesCount })` lays out `Float32Array` frames over a SAB in the EVF1 order (`hotspot` per species, then `lst`, then `sst`); the writer fills `grid.frame(i)` and calls `grid.bump()`, readers `attachFrameGrid(buffer)` and take `hotspot(i, s)` / `lst(i)` / `sst(i)` views with no copy and `await grid.waitVersion(seen)`.

Requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for the SAB path; without them the postMessage fallback is used automatically.

## API reference


| | |
| --- | --- |
| `key(id, defaults, { persist? })` | Typed paths + register defaults; `persist: true` → `localStorage` |
| `hydratePersisted()` | Re-load persisted keys (usually automatic) |
| `ActiveState.state` / `registeredState()` | Current registered map |
| `catalog()` | Same as `registeredState()`; `catalog(A, B)` builds a custom map |
| `init(state, opts?)` / `<ActiveState init={state} ssr />` | Create the store (idempotent; `init` map required) |
| `get` / `set` / `subscribe` | Accept string or `key()` slice |
| `bind()` | Wire path + verb attrs (`text`, `model`, `click`, `each`, drag/drop, …) |
| `reset()` | Clear store **and** key registry (tests / hot reload) |
| `recommended` / `publicPages` from `@calvinjs/active-state/eslint` | Flat-config guardrails (named exports) |
| `hostThread(worker, catalog, opts?)` / `connectThread(self, catalog, opts?)` from `/threads` | Mirror the store across a Worker; returns `{ ids, ready, transport, close }` |
| `createChannel(opts?)` / `openChannel(handle)` from `/threads` | SAB ring pair or MessageChannel behind one `Transport` |
| `allocFrameGrid(shape)` / `attachFrameGrid(sab)` from `/threads` | Zero-copy `Float32Array` frame views with a version counter |

## Scope

**In**

- Keyed observables + singleton bus
- Auto-registering `key()` → `ActiveState.state` (`persist: true` → localStorage)
- React / Next.js: `<ActiveState init={state} />`, `useActiveState`, `ssr`
- Astro / HTMX / static HTML: same DOM path + verb bindings (see `examples/`)
- DOM: `each`, `model`, `click`, drag/drop, …
- CDN build
- ESLint guardrails for AI-assisted codebases

**Out** (later / other packages)

- Theme engines / Alpine-style expression JS in HTML / component system
- First-party Alpine adapter (works alongside today; no dedicated bridge yet)
- Scroll/hover helpers
- HTML catalog sync beyond path/command-shape checks

## Bundle size

| Import | gzip | brotli | Use when |
| --- | ---: | ---: | --- |
| `@calvinjs/active-state` | ~2.3KB | ~2.0KB | Vanilla JS/TS — `init` / `get` / `set` / `subscribe` / `key()` |
| `@calvinjs/active-state/dom` | ~5.1KB | ~4.6KB | HTML verbs — `each` / `model` / `click` / drag-drop (+ core) |
| `@calvinjs/active-state/react` | ~0.7KB | ~0.6KB | Next.js / React — `<ActiveState init={state} />` + `useActiveState` (+ core) |
| CDN IIFE | ~5.3KB | ~4.8KB | core + dom in one browser build |
| `@calvinjs/active-state/threads` | ~5.0KB | ~4.4KB | Workers — `hostThread` / `connectThread`, SAB ring, frame grids (+ core) |

Threads is a separate entry: adding it changed no other entry (measured with `bun run size` on the v0.2 build: `dist/threads/index.js` 17,913 bytes raw, 5,130 gzip, 4,534 brotli; transport 1.4KB, ring 1.3KB, bulk 0.9KB, thread link 0.8KB of gzip).

Sizes are per entry (gzip level 9 / brotli quality 11). `/react` and `/dom` depend on core (one shared singleton). Importing `ActiveState` from `/react` also pulls `/dom` for `bind`. ESLint (`@calvinjs/active-state/eslint`) is opt-in. CDNs typically serve brotli when the browser accepts it.

## Examples

Each demo is a full **kanban board** (drag / add / theme) — not published to npm:

```bash
bun run examples:html    # IIFE kanban
bun run examples:htmx    # kanban + HTMX suggest
bun run examples:react   # useActiveState kanban
bun run examples:astro   # Astro + same board
```

See [`examples/README.md`](./examples/README.md).

## Scripts

```bash
bun run build
bun test
bun run size          # gzip attribution
bun run size:brotli   # brotli totals + attribution
```

## License

MIT




