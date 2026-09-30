import type { Linter, Rule } from "eslint";
import noHooksInFiles from "./rules/no-hooks-in-files";
import noStringKeys from "./rules/no-string-keys";
import validActiveAttr from "./rules/valid-active-attr";

const rules = {
  "no-hooks-in-files": noHooksInFiles,
  "no-string-keys": noStringKeys,
  "valid-active-attr": validActiveAttr,
} satisfies Record<string, Rule.RuleModule>;

const plugin = {
  meta: {
    name: "active-state",
    version: "0.1.0",
  },
  rules,
};

type PublicPagesOptions = {
  /** Globs for public/static surfaces that must stay hook-free. */
  files: string[];
};

/** Always-on AI guardrails (string keys + active-* attr shape). */
const recommended: Linter.Config[] = [
  {
    name: "active-state/recommended",
    plugins: {
      "active-state": plugin,
    },
    rules: {
      "active-state/no-string-keys": "error",
      "active-state/valid-active-attr": "error",
    },
  },
];

/** Hook ban for public/static paths — pass your marketing/public globs. */
function publicPages(options: PublicPagesOptions): Linter.Config[] {
  if (!options?.files?.length) {
    throw new Error(
      "[active-state/eslint] publicPages({ files }) requires at least one glob, e.g. ['app/(marketing)/**/*.{js,jsx,ts,tsx}'].",
    );
  }
  return [
    {
      name: "active-state/public-pages",
      files: options.files,
      plugins: {
        "active-state": plugin,
      },
      rules: {
        "active-state/no-hooks-in-files": "error",
      },
    },
  ];
}

const configs = {
  recommended,
  publicPages,
};

export { configs, plugin, publicPages, recommended, rules };
export default { ...plugin, configs };

export type { PublicPagesOptions };
