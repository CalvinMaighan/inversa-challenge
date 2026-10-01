/**
 * Deterministic scope guard (P4, C-A5): a question that names another app's focus species is refused with
 * this app's refusal text before any model call. Built from the configs: the other apps' taxa names, aliases
 * and ids, minus anything this app itself covers. Everything subtler (abundance, catch, access, safety,
 * places outside the region) is the model's job under the prompt's boundary rules and the tools' region checks.
 */

import { APP_IDS, loadApps, type AppConfig } from "@/shared/apps";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cache = new WeakMap<AppConfig, RegExp | null>();

/** Names of species that belong to other apps only. */
export function foreignSpeciesPattern(app: AppConfig): RegExp | null {
  const cached = cache.get(app);
  if (cached !== undefined) return cached;
  const own = new Set(app.taxa.flatMap((t) => [t.id, t.name, t.scientificName, ...(t.aliases ?? [])]).map((s) => s.toLowerCase()));
  const apps = loadApps();
  const names = new Set<string>();
  for (const id of APP_IDS) {
    if (id === app.id) continue;
    for (const t of apps[id].taxa) {
      for (const name of [t.id, t.name, t.scientificName, ...(t.aliases ?? [])]) {
        const lower = name.toLowerCase();
        if (!own.has(lower) && lower.length >= 4) names.add(lower);
      }
    }
  }
  const pattern = names.size ? new RegExp(`\\b(${[...names].sort((a, b) => b.length - a.length).map(escape).join("|")})(es|s)?\\b`, "i") : null;
  cache.set(app, pattern);
  return pattern;
}

/** The refusal to answer with, or null when the question passes the guard. */
export function scopeGuard(app: AppConfig, question: string): string | null {
  const pattern = foreignSpeciesPattern(app);
  const hit = pattern?.exec(question);
  if (!hit) return null;
  return `${app.agent.refusal} "${hit[0]}" is not something this app has data for.`;
}
