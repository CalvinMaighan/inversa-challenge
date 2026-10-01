/**
 * Most client tests were written for the Everglades build, which is now the python app (PLAN.md C-A5): one focus
 * species (Burmese python, `taxa.id` 1), every layer, the C15 region. Importing this module makes python the
 * active app for the test file and exports what those tests used to read from the removed constants.
 */
import { init } from "@calvinjs/active-state";

import { state } from "client/state";
import { applyApp } from "client/state/app-switch";
import { layersFor } from "client/state/layers";
import { appBBox, getApp, speciesIds } from "shared/apps";

init(state);
applyApp("python");

export const PYTHON = getApp("python");
/** python: `taxa.id` 1. */
export const SPECIES_IDS = speciesIds(PYTHON) as [string];
export const SPECIES_COLORS = PYTHON.taxa.map((t) => t.color);
/** Python's LAYERS preset (LAYERS.defaults is the default app's, carp). */
export const PYTHON_LAYERS = layersFor(PYTHON);
/** The C15 region. */
export const PYTHON_BBOX = appBBox(PYTHON);

/** Make python the active app again (a test that switched apps calls it in afterEach). */
export function selectPython(): void {
  applyApp("python");
}
