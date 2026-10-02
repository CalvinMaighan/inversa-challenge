/** Types for `require-use-client.mjs`. Keep in sync. */
import type { Rule } from "eslint";

export declare function isClientUiFile(filename: string, cwd?: string): boolean;
export declare function hasUseClientDirective(program: { body?: unknown[] } | undefined): boolean;
export declare const requireUseClientRule: Rule.RuleModule;
export default requireUseClientRule;
