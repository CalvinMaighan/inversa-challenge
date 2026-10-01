/**
 * Species styling and filtering for globe primitives (T41). Colours are hex because Cesium's
 * `Color.fromCssColorString` does not parse the oklch() theme tokens.
 *
 * A species app has one focus species (its config `taxa[0]`): its sightings draw the app's icon in the config
 * colour. A record of any other taxon is not the app's and is not drawn.
 */
import { activeApp } from "client/state/app";
import { speciesIds } from "shared/apps";

/** EVF taxon ids are `taxa.id`, 1-based in config order (PLAN.md C-A4): the focus species is 1. */
export function isFocusTaxon(taxonId: number): boolean {
  return Number.isInteger(taxonId) && taxonId >= 1 && taxonId <= activeApp().taxa.length;
}

/** Species index of a taxon id, or -1 for a taxon that is not the app's. */
export function speciesIndexOfTaxon(taxon: number): number {
  return isFocusTaxon(taxon) ? taxon - 1 : -1;
}

/** The marker colour of a focus taxon (the config colour); null for any other taxon. */
export function colorOfTaxon(taxon: number): string | null {
  const i = speciesIndexOfTaxon(taxon);
  return i >= 0 ? activeApp().taxa[i]!.color : null;
}

/** Species indices the LAYERS filter shows (a boolean per species key), in config order. */
export function enabledSpecies(filter: Readonly<Record<string, unknown>> | undefined): number[] {
  const out: number[] = [];
  speciesIds(activeApp()).forEach((id, i) => {
    if (filter?.[id] !== false) out.push(i);
  });
  return out;
}

/** Whether a record of `taxon` is drawn: a focus species that the filter shows. */
export function recordShown(filter: Readonly<Record<string, unknown>> | undefined, taxon: number): boolean {
  const s = speciesIndexOfTaxon(taxon);
  return s >= 0 && enabledSpecies(filter).includes(s);
}
