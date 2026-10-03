import { describe, expect, test } from "bun:test";

import { INTRO_CSS, introBootstrapScript } from "client/intro/bootstrap";
import { INTRO_ATTR, INTRO_FLAG } from "client/intro/constants";

/** Runs the head script against a fake page. */
function run(search: string | null, webdriver = false): { attrs: Record<string, string>; flag: unknown } {
  const attrs: Record<string, string> = {};
  const win: Record<string, unknown> = {};
  const location = { search: search ?? "" };
  const navigator = { webdriver };
  const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
  new Function("document", "location", "window", "navigator", "URLSearchParams", introBootstrapScript())(document, location, win, navigator, URLSearchParams);
  return { attrs, flag: win[INTRO_FLAG] };
}

describe("intro head script", () => {
  test("marks the page and sets the flag on every load", () => {
    const { attrs, flag } = run("?app=python");
    expect(attrs[INTRO_ATTR]).toBe("");
    expect(flag).toBe(true);
  });

  test("?intro=0 leaves the page alone", () => {
    const { attrs, flag } = run("?intro=0");
    expect(attrs[INTRO_ATTR]).toBeUndefined();
    expect(flag).toBeUndefined();
  });

  test("automated browsers skip the gate unless ?intro=1 asks for it", () => {
    expect(run("?app=carp", true).attrs[INTRO_ATTR]).toBeUndefined();
    expect(run("?intro=1", true).attrs[INTRO_ATTR]).toBe("");
  });

  test("the stylesheet hides the chat and the HUD only while the page is marked, and fades them in after", () => {
    expect(INTRO_CSS).toContain(`html[${INTRO_ATTR}] [data-slot="hud"]`);
    expect(INTRO_CSS).toContain(`html[${INTRO_ATTR}] [data-slot="side"]`);
    expect(INTRO_CSS).toContain("visibility:hidden");
    expect(INTRO_CSS).toMatch(/\[data-slot="hud"\],\[data-slot="side"\]\{transition:opacity/);
  });
});
