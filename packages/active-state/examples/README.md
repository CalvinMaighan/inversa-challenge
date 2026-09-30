# Examples

Each example is a **full kanban board** (drag cards, add cards, dark-by-default theme, collapsible columns). Theme + board positions persist via `key(..., { persist: true })`. Shared motion/CSS lives in each example’s `styles.css` (kept in sync from `html/styles.css`).

Read the demo in **one file** per stack:

| Example | Read this | Stack | Run | Port |
| --- | --- | --- | --- | ---: |
| [`html`](./html) | [`index.html`](./html/index.html) | Declarative `active-*` attrs | `bun run examples:html` | 5177 |
| [`htmx`](./htmx) | [`index.html`](./htmx/index.html) | Same + HTMX suggest | `bun run examples:htmx` | 5178 |
| [`react`](./react) | [`src/main.tsx`](./react/src/main.tsx) | Vite + `useActiveState` | `bun run examples:react` | 5179 |
| [`astro`](./astro) | [`src/pages/index.astro`](./astro/src/pages/index.astro) | Astro shell, same attrs | `bun run examples:astro` | 5180 |

None of these ship on npm (`package.json` `"files"` is only `dist` + docs).

**Prerequisite:**

```bash
bun run build
```

Shared only: [`shared/serve-static.ts`](./shared/serve-static.ts) (tiny Bun static server for html/htmx).

## Widely used stacks not included

| Stack | Why skipped (for now) |
| --- | --- |
| **Next.js** | Same as React + `<ActiveState init={state} ssr />` |
| **Vue / Svelte / Solid** | No first-party adapter — use core |
| **Alpine** | Works alongside; bridge only if demand appears |
| **Preact** | Use React entry or core |

PRs welcome for thin demos of the above if they stay small.

