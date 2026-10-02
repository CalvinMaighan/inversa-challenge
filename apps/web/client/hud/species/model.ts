/**
 * The species chip's model, pure over the LAYERS filter and the sightings layer's breakdown (counts per taxon id
 * over the window, before the filter): the app's one species with its icon, colour, switch and count.
 */
import { activeApp } from "client/state/app";
import type { LayersState, SpeciesId } from "client/state/layers";

import { speciesGuide } from "../help/content";

export type ChipModel = {
  /** The species key (`python`, `lionfish`): what the chip toggles. */
  key: SpeciesId;
  name: string;
  /** The description line under the name on hover. */
  full: string;
  line: string;
  color: string;
  /** App icon id (`shared/app-icons.ts`). */
  icon: string;
  on: boolean;
  count: number | null;
};

/** One chip per tracked species of the active app (each its own switch), in the config's order; none in an app without any. */
export function speciesChips(filter: LayersState["species"], breakdown: Readonly<Record<string, number>> | null): ChipModel[] {
  const app = activeApp();
  const guide = speciesGuide(app);
  return app.taxa.flatMap((taxon, i): ChipModel[] => {
    const g = guide[i];
    if (!g) return [];
    return [
      {
        key: g.id,
        name: g.name,
        full: g.full,
        line: g.line,
        color: taxon.color,
        icon: app.icon,
        on: filter[g.id] !== false,
        count: breakdown ? (breakdown[String(taxon.dbId)] ?? 0) : null,
      },
    ];
  });
}

/** The chip of the active app's species, or null in an app without one (carp). */
export function speciesChip(filter: LayersState["species"], breakdown: Readonly<Record<string, number>> | null): ChipModel | null {
  const app = activeApp();
  const guide = speciesGuide(app)[0];
  const taxon = app.taxa[0];
  if (!guide || !taxon) return null;
  return {
    key: guide.id,
    name: guide.name,
    full: guide.full,
    line: guide.line,
    color: taxon.color,
    icon: app.icon,
    on: filter[guide.id] !== false,
    // Taxon id 1 is the focus species (C-A4).
    count: breakdown ? (breakdown["1"] ?? 0) : null,
  };
}
