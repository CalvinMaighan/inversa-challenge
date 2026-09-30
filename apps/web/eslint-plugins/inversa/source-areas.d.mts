/**
 * Types for the ESM helper module next to this file, so the TypeScript tests can import it
 * (`allowJs` is off). Keep in sync with `source-areas.mjs`.
 */
export declare const MANAGED_ROOTS: readonly string[];
export declare function physicalFilename(filename: string): string;
export declare function repoRelative(filename: string, cwd?: string): string | null;
export declare function sourceAreaForFilename(filename: string, cwd?: string): { root: string; area: string } | null;
export declare function importedTarget(source: string, fileDir: string, cwd?: string): string | null;
