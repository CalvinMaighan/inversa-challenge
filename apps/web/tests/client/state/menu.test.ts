import { describe, expect, test } from "bun:test";

import { MENU } from "client/state/menu";

describe("MENU", () => {
  test("no menu is open at first", () => {
    expect(MENU.defaults).toBeNull();
  });
});
