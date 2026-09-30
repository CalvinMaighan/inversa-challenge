# active-theme

Mode + color theme engine. Sets `data-theme` / `data-accent` and CSS variables on `:root` so the whole UI updates immediately.

Persist + cross-tab sync are **on by default**. Use [`active-theme/lite`](#lite) when you only want apply. Prefer [`active-theme/state`](#with-active-state) when the app already uses [`active-state`](https://github.com/CalvinMaighan/active-state).

## Install

```bash
bunx add active-theme
```

## Quick start (standalone)

```ts
import { defineTheme, hydrateTheme, setMode, setColor } from "active-theme";

export const theme = defineTheme({
  defaultMode: "dark",
  defaultColor: "orange",
  colors: {
    orange: { hue: 58, chromaBase: 0.036 },
    blue: { hue: 236, chromaBase: 0.036 },
  },
});

hydrateTheme(theme); // boot from localStorage → :root
setMode("light");
setColor("blue");
```

## With active-state (recommended in apps that already have a bus)

One store. Bus owns persist; `<ActiveTheme />` only paints `:root`.

```ts
// client/theme.ts
import { catalog } from "active-state";
import { defineTheme } from "active-theme";
import { themeKeys } from "active-theme/state";

export const theme = defineTheme({
  defaultMode: "dark",
  defaultColor: "orange",
  colors: {
    orange: { hue: 58, chromaBase: 0.036 },
    blue: { hue: 236, chromaBase: 0.036 },
  },
  persist: false, // bus owns storage
});

export const { THEME, ACCENT_COLOR } = themeKeys({
  defaultMode: "dark",
  defaultColor: "orange",
});

// merge into your full client catalog
export const themeState = catalog(THEME, ACCENT_COLOR);
```

```tsx
// app/layout.tsx
import { state } from "client/state"; // includes theme keys
import { theme } from "client/theme";
import { ActiveState } from "active-state/react";
import { ActiveTheme } from "active-theme/state";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ActiveState init={state} ssr />
        <ActiveTheme init={theme} />
        {children}
      </body>
    </html>
  );
}
```

```tsx
import { useActiveState } from "active-state/react";
import { THEME, ACCENT_COLOR } from "client/theme";

const [mode, setMode] = useActiveState(THEME);
const [color, setColor] = useActiveState(ACCENT_COLOR);
```

## Entries

| Import | Role |
| --- | --- |
| `active-theme` | Full engine — apply + own persist + shared |
| `active-theme/lite` | Apply only — no storage |
| `active-theme/react` | `useTheme` when not on active-state |
| `active-theme/state` | `<ActiveTheme init={theme} />` + `themeKeys()` |
| `active-theme/emotion` | CSS strings for Emotion (or any injector) |

### Lite

```ts
import { defineTheme, applyMode, applyColor } from "active-theme/lite";

const theme = defineTheme({
  defaultColor: "orange",
  colors: { orange: { hue: 58 } },
});
applyMode(theme, "dark");
applyColor(theme, "orange");
```

## Scripts

```bash
bun run build
bun test
```

## License

MIT
