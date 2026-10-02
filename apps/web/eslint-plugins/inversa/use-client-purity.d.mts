/** Types for `use-client-purity.mjs`. Keep in sync. */
import type { Rule } from "eslint";

/** Why a `"use client"` module may not import `source`, or null when the import is browser-safe. */
export declare function serverOnlyReason(source: string, fileDir: string, cwd?: string): string | null;
/** The literal env-var name of a `process.env.X` / `process.env["X"]` read, else null. */
export declare function envNameOf(node: unknown): string | null;
export declare const useClientPurityRule: Rule.RuleModule;
export default useClientPurityRule;
