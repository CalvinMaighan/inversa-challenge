"use client";

import { useSyncExternalStore } from "react";
import { subscribe } from "@calvinjs/active-state";

import { APP, activeAppId } from "client/state/app";
import { DEFAULT_APP_ID, getApp, type AppConfig, type AppId } from "shared/apps";

const subscribeApp = (cb: () => void) => subscribe(APP, cb);
/** Server HTML (and hydration) is always the default app; AppBoot switches after hydration. */
const serverApp = (): AppId => DEFAULT_APP_ID;

/** The active app's config; re-renders when the selector switches apps. Safe in server rendering. */
export function useActiveApp(): AppConfig {
  return getApp(useSyncExternalStore(subscribeApp, activeAppId, serverApp));
}
