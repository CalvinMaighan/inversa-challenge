/** Types for `prefer-catalog-constants.mjs`. Keep in sync. */
import type { Rule } from "eslint";

export type VocabularyConstant = "SPECIES_IDS" | "LAYER_IDS" | "QUALITY_CODES";
/** Mirrors the shared/ lists; a test keeps the two in step. */
export declare const CATALOG_VOCABULARY: Record<VocabularyConstant, string[]>;
export declare const CONSTANT_MODULE: Record<VocabularyConstant, string>;
/** value → the shared constant to use instead. */
export declare const VOCABULARY_LOOKUP: Map<string, VocabularyConstant>;
export declare const preferCatalogConstantsRule: Rule.RuleModule;
export default preferCatalogConstantsRule;
