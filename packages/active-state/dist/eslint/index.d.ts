import { Linter, Rule } from 'eslint';

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
type Configs = {
    recommended: Linter.Config[];
    publicPages: (options: PublicPagesOptions) => Linter.Config[];
};
declare const configs: Configs;
declare const pluginWithConfigs: typeof plugin & {
    configs: Configs;
};

export { type PublicPagesOptions, configs, pluginWithConfigs as default, plugin, publicPages, recommended, rules };
