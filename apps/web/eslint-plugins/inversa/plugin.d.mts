/** Types for `plugin.mjs` (allowJs is off, so TypeScript callers need this). Keep in sync. */
import type { ESLint, Linter } from "eslint";

declare const plugin: ESLint.Plugin & { rules: NonNullable<ESLint.Plugin["rules"]> };
export declare const configs: Linter.Config[];
export default plugin;
