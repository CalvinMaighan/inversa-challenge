"use client";

import { Fragment, useLayoutEffect, type ReactNode } from "react";
import { subscribe } from "@calvinjs/active-state";

import { APP, activeApp } from "client/state/app";

import { bootApp } from "./switch";
import { useActiveApp } from "./use-active-app";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** `<html data-app>` and the tab title follow the active app. */
function reflect(): void {
  const app = activeApp();
  document.documentElement.setAttribute("data-app", app.id);
  document.title = app.name;
}

/**
 * Applies the resolved app once the store has hydrated (PLAN.md C-A5): `?app=`, a share link's app, localStorage
 * `inversa.app`, carp. Server HTML is always the default app; the head script (`appBootstrapScript`) hid the page
 * when the resolved app differs, and this un-hides it after the switch, so no other app ever paints. Mounted in
 * Providers right after `<ActiveState>`, so its layout effect runs after the store hydrated and before any
 * child's effects (the globe, the HUD) read the app.
 */
export default function AppBoot() {
  useLayoutEffect(() => {
    const store = storage();
    bootApp({ location: window.location, history: window.history, storage: store }, store);
    reflect();
    document.documentElement.removeAttribute("data-app-pending");
    return subscribe(APP, reflect);
  }, []);
  return null;
}

/**
 * Remounts its children when the app changes: the HUD and the chat column hold per-app state (subscriptions,
 * the team board, the agent thread, memoised species lists), and a fresh mount is the one way none of it leaks.
 * The globe is not wrapped: it re-reads VIEW and LAYERS, which the switch resets.
 */
export function AppScope({ children }: { children: ReactNode }) {
  const app = useActiveApp();
  return <Fragment key={app.id}>{children}</Fragment>;
}
