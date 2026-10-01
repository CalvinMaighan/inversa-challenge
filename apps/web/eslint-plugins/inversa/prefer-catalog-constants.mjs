/**
 * @file Keep the domain vocabulary in `shared/`, not sprinkled through the UI and server. Ported from big-value.
 *
 * App ids, layer ids and quality codes are contracts: the API routes by app (`/v1/<app>/...`), the voice tools
 * validate layers, and the globe keys its layers by them. An app id retyped in a check, a layer id in a toggle, or
 * a quality code in a comparison is a silent divergence waiting to happen. This rule points at the shared
 * constant. Species are no longer a constant: they are each app's config `taxa` (PLAN.md C-A3), read through
 * `shared/apps`.
 *
 * Deliberately excluded: evidence kinds ("sighting", "alert", …) and feed health ("down", "stale", …), which
 * collide with ordinary English and would flood the lint output.
 */
import { sourceAreaForFilename } from "./source-areas.mjs";

/** Mirrors the shared/ lists. `tests/eslint-plugins/inversa/prefer-catalog-constants.test.ts` keeps it honest. */
export const CATALOG_VOCABULARY = {
  /** shared/apps APP_IDS */
  APP_IDS: ["carp", "lionfish", "python"],
  /** shared/apps LAYER_IDS (re-exported by shared/voice/ui-tools) */
  LAYER_IDS: ["sightings", "hotspots", "lst", "sst", "stations", "alerts", "missions", "peers", "notes", "vessels"],
  /** shared/frames.ts QUALITY_CODES */
  QUALITY_CODES: ["research", "needs_id", "casual", "curated"],
};

/** Where each constant is exported from. */
export const CONSTANT_MODULE = {
  APP_IDS: "shared/apps",
  LAYER_IDS: "shared/apps",
  QUALITY_CODES: "shared/frames",
};

/** value → the shared constant to use instead. */
export const VOCABULARY_LOOKUP = new Map(
  Object.entries(CATALOG_VOCABULARY).flatMap(([constant, values]) => values.map((value) => [value, constant])),
);

/** Areas where the vocabulary must come from shared/. shared/ defines it; tests/, eval/ and e2e/ are exempt. */
const ENFORCED_AREAS = new Set(["app", "app-api", "client", "server"]);

/** @type {import('eslint').Rule.RuleModule} */
export const preferCatalogConstantsRule = {
  meta: {
    type: "suggestion",
    docs: { description: "Use the shared/ domain vocabulary instead of string literals" },
    schema: [],
    messages: {
      preferConstant:
        'Use {{constant}} from "{{module}}" instead of the literal "{{value}}". The API and the voice tools validate against the same list.',
    },
  },

  create(context) {
    const cwd = typeof context.cwd === "string" ? context.cwd : context.getCwd();
    const area = sourceAreaForFilename(context.filename, cwd);
    if (!area || !ENFORCED_AREAS.has(area.area)) return {};

    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        const constant = VOCABULARY_LOOKUP.get(node.value);
        if (!constant) return;
        // Module specifiers are paths, not vocabulary.
        const parentType = node.parent?.type;
        if (parentType === "ImportDeclaration" || parentType === "ExportNamedDeclaration" || parentType === "ExportAllDeclaration" || parentType === "ImportExpression") return;
        context.report({
          node,
          messageId: "preferConstant",
          data: { constant, module: CONSTANT_MODULE[constant], value: node.value },
        });
      },
    };
  },
};

export default preferCatalogConstantsRule;
