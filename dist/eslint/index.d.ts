import { Linter, Rule } from 'eslint';

/**
 * @fileoverview Shared types for ESLint Core.
 */

/**
 * The human readable severity level used in a configuration.
 */
type SeverityName = "off" | "warn" | "error";
/**
 * The numeric severity level for a rule.
 *
 * - `0` means off.
 * - `1` means warn.
 * - `2` means error.
 */
type SeverityLevel = 0 | 1 | 2;
/**
 * The severity of a rule in a configuration.
 */
type Severity = SeverityName | SeverityLevel;
/**
 * The configuration for a rule.
 */
type RuleConfig<RuleOptions extends unknown[] = unknown[]> = Severity | [Severity, ...Partial<RuleOptions>];
/**
 * A collection of rules and their configurations.
 */
interface RulesConfig {
    [key: string]: RuleConfig;
}

declare const rules: {
    "no-hooks-in-files": Rule.RuleModule;
    "no-string-keys": Rule.RuleModule;
    "valid-active-attr": Rule.RuleModule;
};
declare const plugin: {
    meta: {
        name: string;
        version: string;
    };
    rules: {
        "no-hooks-in-files": Rule.RuleModule;
        "no-string-keys": Rule.RuleModule;
        "valid-active-attr": Rule.RuleModule;
    };
};
type PublicPagesOptions = {
    /** Globs for public/static surfaces that must stay hook-free. */
    files: string[];
};
/** Always-on AI guardrails (string keys + active-* attr shape). */
declare const recommended: Linter.Config[];
/** Hook ban for public/static paths — pass your marketing/public globs. */
declare function publicPages(options: PublicPagesOptions): Linter.Config[];
declare const configs: {
    recommended: Linter.Config<RulesConfig>[];
    publicPages: typeof publicPages;
};

declare const _default: {
    configs: {
        recommended: Linter.Config<RulesConfig>[];
        publicPages: typeof publicPages;
    };
    meta: {
        name: string;
        version: string;
    };
    rules: {
        "no-hooks-in-files": Rule.RuleModule;
        "no-string-keys": Rule.RuleModule;
        "valid-active-attr": Rule.RuleModule;
    };
};

export { type PublicPagesOptions, configs, _default as default, plugin, publicPages, recommended, rules };
