/** Types for `state-key-registration.mjs`. Keep in sync. */
import type { Rule } from "eslint";

/** Names passed to `catalog(...)` in client/state/index.ts, or null when it cannot be read. */
export declare function registeredStateKeys(cwd?: string): Set<string> | null;
/** True when the linted file is a state slice that must register its keys. */
export declare function ownsStateKeys(filename: string, cwd?: string): boolean;
export declare const stateKeyRegistrationRule: Rule.RuleModule;
export default stateKeyRegistrationRule;
