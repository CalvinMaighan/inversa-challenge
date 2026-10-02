/**
 * The app selector's rows (PLAN.md C-A5, docs/APPS.md "App selector"): one per app in APP_IDS order, with its
 * icon, name, one-line question and feed-health dot. Pure over the configs and the parsed `/health`.
 */
import { APP_IDS, getApp, type AppConfig, type AppId } from "shared/apps";

import type { Tone } from "../primitives";
import { healthLabel, type AppHealth } from "./health";

/** Tint of an app without a species (carp): a river blue, apart from the focus colours. */
export const CONDITIONS_TINT = "#7f7fff";

/** Icon tint: the app's species colour, else the conditions tint. */
export function appTint(app: AppConfig): string {
  return app.taxa[0]?.color ?? CONDITIONS_TINT;
}

const HEALTH_TONE: Record<AppHealth, Tone> = { nominal: "ok", lagging: "warn", stale: "stale", down: "danger", unknown: "muted" };

export type AppOption = {
  id: AppId;
  name: string;
  question: string;
  icon: string;
  tint: string;
  health: AppHealth;
  tone: Tone;
  healthLabel: string;
  selected: boolean;
};

export function appOptions(active: AppId, health: Readonly<Record<AppId, AppHealth>> | null): AppOption[] {
  return APP_IDS.map((id) => {
    const app = getApp(id);
    const h = health?.[id] ?? "unknown";
    return { id, name: app.name, question: app.question, icon: app.icon, tint: appTint(app), health: h, tone: HEALTH_TONE[h], healthLabel: healthLabel(h), selected: id === active };
  });
}

/** Roving focus in the list: the next index for an arrow, Home or End key, or null for any other key. */
export function nextIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
