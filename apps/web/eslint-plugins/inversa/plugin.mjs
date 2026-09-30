/**
 * @file Custom ESLint rules for the web app's app / client / server / shared architecture.
 *
 * Ported from big-value's `eslint-plugins/bigvalue`, adapted to apps/web paths. Tests live in
 * tests/eslint-plugins/inversa/.
 */
import { preferCatalogConstantsRule } from "./prefer-catalog-constants.mjs";
import { requireUseClientRule } from "./require-use-client.mjs";
import { sharedPurityRule } from "./shared-purity.mjs";
import { stateKeyRegistrationRule } from "./state-key-registration.mjs";
import { testMirrorRule } from "./test-mirror.mjs";
import { useClientPurityRule } from "./use-client-purity.mjs";

const plugin = {
  meta: {
    name: "eslint-plugin-inversa",
    version: "0.0.0",
  },
  rules: {
    "prefer-catalog-constants": preferCatalogConstantsRule,
    "require-use-client": requireUseClientRule,
    "shared-purity": sharedPurityRule,
    "state-key-registration": stateKeyRegistrationRule,
    "test-mirror": testMirrorRule,
    "use-client-purity": useClientPurityRule,
  },
};

/** Every rule at error: each is an invariant the tree already satisfies, so a regression fails CI. */
export const configs = [
  {
    name: "inversa/architecture",
    plugins: { inversa: plugin },
    rules: Object.fromEntries(Object.keys(plugin.rules).map((name) => [`inversa/${name}`, "error"])),
  },
];

export default plugin;
