/**
 * @file Keep the domain vocabulary in `shared/`, not sprinkled through the UI and server. Ported from big-value.
 *
 * Species, layer ids and quality codes are contracts: the Rust API writes them into EVF frames and GraphQL, the
 * voice tools validate against them, and the globe keys its layers by them. A species retyped in a filter, a
 * layer id in a toggle, or a quality code in a comparison is a silent divergence waiting to happen. This rule
 * points at the shared constant.
 *
 * Deliberately excluded: evidence kinds ("sighting", "alert", …) and feed health ("down", "stale", …), which
 * collide with ordinary English and would flood the lint output.
 */
import { sourceAreaForFilename } from "./source-areas.mjs";

/** Mirrors the shared/ lists. `tests/eslint-plugins/inversa/prefer-catalog-constants.test.ts` keeps it honest. */
export const CATALOG_VOCABULARY = {
  /** shared/voice/ui-tools.ts SPECIES_IDS (same order as shared/frames.ts EVF_SPECIES) */
  SPECIES_IDS: ["python", "tegu", "iguana", "lionfish"],
  /** shared/voice/ui-tools.ts LAYER_IDS */
  LAYER_IDS: ["sightings", "hotspots", "lst", "sst", "stations", "alerts", "missions", "peers", "notes"],
  /** shared/frames.ts QUALITY_CODES */
  QUALITY_CODES: ["research", "needs_id", "casual", "curated"],
};

/** Where each constant is exported from. */
export const CONSTANT_MODULE = {
  SPECIES_IDS: "shared/voice/ui-tools",
  LAYER_IDS: "shared/voice/ui-tools",
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
