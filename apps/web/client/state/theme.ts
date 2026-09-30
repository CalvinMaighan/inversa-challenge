import type { KeyPrimitive } from "@calvinjs/active-state";
import type { ThemeMode } from "active-theme";
import { themeKeys } from "active-theme/state";

import { DEFAULT_ACCENT, DEFAULT_MODE, type AccentId, type ThemeModeId } from "client/themes/palette";

/**
 * THEME and ACCENT_COLOR from active-theme's adapter: persisted and shared across tabs, painted onto `:root` by
 * `<ActiveTheme />`. The adapter types modes as "light" | "dark"; re-typed here to carry "tactical" too.
 */
const keys = themeKeys({ defaultMode: DEFAULT_MODE as ThemeMode, defaultColor: DEFAULT_ACCENT, persist: true, shared: true });

export const THEME = keys.THEME as KeyPrimitive<"THEME", ThemeModeId>;
export const ACCENT_COLOR = keys.ACCENT_COLOR as KeyPrimitive<"ACCENT_COLOR", AccentId>;
