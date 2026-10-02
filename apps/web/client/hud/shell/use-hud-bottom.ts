"use client";

import { useLayoutEffect, type RefObject } from "react";

import { GUTTER_PX } from "./geometry";

/**
 * A timeline (the shared one, carp's stage timeline) writes `--hud-bottom` on the HUD root: its own top, from the
 * pane's bottom, plus one gutter, however tall it wrapped. Panels, cards and the bottom bar stop there, so each sits
 * exactly one gutter above it (GE9).
 */
export function useHudBottom(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    const hud = el?.closest<HTMLElement>("[data-hud]");
    if (!el || !hud || typeof ResizeObserver !== "function") return;
    const apply = () => {
      const gap = hud.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
      if (gap > 0) hud.style.setProperty("--hud-bottom", `${gap + GUTTER_PX}px`);
    };
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    observer.observe(hud);
    apply();
    return () => {
      observer.disconnect();
      hud.style.removeProperty("--hud-bottom");
    };
  }, [ref]);
}
