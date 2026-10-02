/** Types for `test-mirror.mjs`. Keep in sync. */
import type { Rule } from "eslint";

export declare const MIRRORED_TIERS: { root: string; extensions: string[] }[];
/** `shared/x.ts` → `tests/shared/x.test.ts`. */
export declare function mirroredTestPath(sourcePath: string): string;
/** The tier a source file belongs to, or null when the file is out of scope. */
export declare function mirroredRootFor(filename: string, cwd?: string): string | null;
/** True when the program is only re-exports and imports. */
export declare function isBarrel(program: { body?: unknown[] } | undefined): boolean;
/** Module paths, without extension, imported by any test under tests/. */
export declare function modulesImportedByTests(cwd?: string): Set<string>;
/** True when the mirrored test exists, or a test imports the module. */
export declare function hasTest(relative: string, cwd?: string): boolean;
export declare const testMirrorRule: Rule.RuleModule;
export default testMirrorRule;
