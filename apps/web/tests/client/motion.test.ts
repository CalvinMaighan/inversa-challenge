import { afterEach, describe, expect, test } from "bun:test";

import { prefersReducedMotion } from "client/motion";

const g = globalThis as unknown as { window?: unknown };
const saved = g.window;

afterEach(() => {
  g.window = saved;
});

function withMedia(matches: (query: string) => boolean): void {
  g.window = { matchMedia: (query: string) => ({ matches: matches(query) }) };
}

describe("prefersReducedMotion", () => {
  test("follows the reduced-motion media query", () => {
    withMedia((q) => q === "(prefers-reduced-motion: reduce)");
    expect(prefersReducedMotion()).toBe(true);
    withMedia(() => false);
    expect(prefersReducedMotion()).toBe(false);
  });

  test("is false without a window or matchMedia (server render, old engines)", () => {
    g.window = undefined;
    expect(prefersReducedMotion()).toBe(false);
    g.window = {};
    expect(prefersReducedMotion()).toBe(false);
  });
});
