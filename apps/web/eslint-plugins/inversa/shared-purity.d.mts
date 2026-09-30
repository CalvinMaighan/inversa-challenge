/** Types for `shared-purity.mjs`. Keep in sync. */
import type { Rule } from "eslint";

/** Why `source` is impure, or null when a runtime-neutral module may import it. */
export declare function impurity(source: string): string | null;
export declare function isStaticNamePosition(node: unknown): boolean;
export declare const sharedPurityRule: Rule.RuleModule;
export default sharedPurityRule;
