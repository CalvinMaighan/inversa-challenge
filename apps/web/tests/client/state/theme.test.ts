import { describe, expect, test } from "bun:test";
import { get, init, isPersisted, isShared, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { ACCENT_COLOR, THEME } from "client/state/theme";
import { DEFAULT_ACCENT, DEFAULT_MODE, type ThemeModeId } from "client/themes/palette";

init(state);

describe("THEME / ACCENT_COLOR", () => {
  test("use the ids <ActiveTheme /> reads by default", () => {
    expect(THEME.$).toBe("THEME");
    expect(ACCENT_COLOR.$).toBe("ACCENT_COLOR");
  });

  test("default to the palette defaults the bootstrap script and GlobalStyles assume", () => {
    expect(THEME.defaults).toBe(DEFAULT_MODE);
    expect(ACCENT_COLOR.defaults).toBe(DEFAULT_ACCENT);
  });

  test("persist and sync across tabs", () => {
    for (const id of [THEME.$, ACCENT_COLOR.$]) {
      expect(isPersisted(id)).toBe(true);
      expect(isShared(id)).toBe(true);
    }
  });

  test("carry the tactical mode through the bus", () => {
    set<ThemeModeId>(THEME, "tactical");
    expect(get<ThemeModeId>(THEME)).toBe("tactical");
    set<ThemeModeId>(THEME, DEFAULT_MODE);
  });
});
