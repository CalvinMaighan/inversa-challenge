/**
 * The three app configs (PLAN.md C-A3, C-A5). `spec/apps/{carp,lionfish,python}.json` are bundled through the
 * `app-configs/*` path alias (tsconfig.json), so the browser, the workers and the server read the same files
 * synchronously and validate them once.
 */
import carp from "app-configs/carp.json";
import lionfish from "app-configs/lionfish.json";
import python from "app-configs/python.json";

import { parseApps, type AppConfig, type AppId } from "./schema";

export * from "./geo";
export * from "./schema";

let apps: Readonly<Record<AppId, AppConfig>> | null = null;

/** Every app config, validated on first call. Throws AppConfigError when a file breaks the contract. */
export function loadApps(): Readonly<Record<AppId, AppConfig>> {
  apps ??= parseApps({ carp, lionfish, python });
  return apps;
}

export function getApp(id: AppId): AppConfig {
  return loadApps()[id];
}
