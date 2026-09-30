// src/eslint/rules/no-hooks-in-files.ts
var HOOK = /^use[A-Z]/;
var MSG = '[active-state] React hooks are not allowed in this file (public/static surface). Keep it a Server Component, or move interactivity into a small "use client" island outside this lint path. Shared UI state: define key() in a catalog, import { state } from that catalog, mount <ActiveState init={state} ssr />, then call useActiveState(KEY) / ActiveState.set(KEY, \u2026) only inside that client island.';
function isHookName(name) {
  return typeof name === "string" && HOOK.test(name);
}
var rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow React hooks in configured public/static files (agent guardrail)."
    },
    schema: [],
    messages: {
      noHooks: MSG
    }
  },
  create(context) {
    return {
      ImportSpecifier(node) {
        if (node.parent.type === "ImportDeclaration" && typeof node.parent.source.value === "string" && (node.parent.source.value === "react" || node.parent.source.value.startsWith("react/")) && isHookName(node.imported.type === "Identifier" ? node.imported.name : null)) {
          context.report({ node, messageId: "noHooks" });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier" && isHookName(callee.name)) {
          context.report({ node, messageId: "noHooks" });
          return;
        }
        if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && isHookName(callee.property.name)) {
          context.report({ node, messageId: "noHooks" });
        }
      }
    };
  }
};
var no_hooks_in_files_default = rule;

// src/eslint/rules/no-string-keys.ts
var MSG2 = '[active-state] Pass a key() slice (e.g. LAYOUT or LAYOUT.nav), not a string literal. Define the key with key("LAYOUT", defaults), export it from your catalog, import that const, and use it here so TypeScript and agents stay aligned.';
var API = /* @__PURE__ */ new Set([
  "get",
  "set",
  "subscribe",
  "useActiveState",
  "useClientState",
  "useLocalState",
  "clearPersisted",
  "clearLocalStateKey",
  "resolveKey"
]);
var PKG = /^(@calvinjs\/active-state)(\/.*)?$/;
function isStringLiteral(node) {
  return !!node && typeof node === "object" && node.type === "Literal" && typeof node.value === "string";
}
var rule2 = {
  meta: {
    type: "problem",
    docs: {
      description: "Require key() slices instead of string literals for active-state APIs."
    },
    schema: [],
    messages: {
      useKeySlice: MSG2
    }
  },
  create(context) {
    const locals = /* @__PURE__ */ new Map();
    const namespaces = /* @__PURE__ */ new Set();
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== "string") return;
        if (!PKG.test(node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportDefaultSpecifier") {
            namespaces.add(spec.local.name);
            continue;
          }
          if (spec.type === "ImportNamespaceSpecifier") {
            namespaces.add(spec.local.name);
            continue;
          }
          if (spec.type === "ImportSpecifier") {
            const imported = spec.imported.type === "Identifier" ? spec.imported.name : null;
            if (imported && API.has(imported)) {
              locals.set(spec.local.name, imported);
            }
            if (imported === "ActiveState") {
              namespaces.add(spec.local.name);
            }
          }
        }
      },
      CallExpression(node) {
        if (!isStringLiteral(node.arguments[0])) return;
        const callee = node.callee;
        if (callee.type === "Identifier" && locals.has(callee.name)) {
          context.report({
            node: node.arguments[0],
            messageId: "useKeySlice"
          });
          return;
        }
        if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" && namespaces.has(callee.object.name) && callee.property.type === "Identifier" && API.has(callee.property.name)) {
          context.report({
            node: node.arguments[0],
            messageId: "useKeySlice"
          });
        }
      }
    };
  }
};
var no_string_keys_default = rule2;

// src/eslint/rules/valid-active-attr.ts
var PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
var COMMAND = /^(toggle|set|push|remove|move)(:|→|>)[A-Za-z_][\w.]*([\s\S]*)$/;
var PATH_ATTRS = /* @__PURE__ */ new Set([
  "active-text",
  "active-show",
  "active-model",
  "active-toggle",
  "active-drag",
  "active-each",
  "active-as"
]);
var COMMAND_ATTRS = /* @__PURE__ */ new Set([
  "active-click",
  "active-submit",
  "active-drop"
]);
var PATH_MSG = '[active-state] Path must look like KEY.field or each-alias.field (e.g. "LAYOUT.nav" or "card.title").';
var COMMAND_MSG = `[active-state] Use verb:path (no JS expressions). Examples: active-click="toggle:THEME.dark", active-click='set:THEME.mode:"dark"', active-drop="move\u2192col.cards", active-submit="push:col.cards".`;
var asNode = (node) => node;
var rule3 = {
  meta: {
    type: "problem",
    docs: {
      description: "Validate active-* path / command attrs (agent guardrail)."
    },
    schema: [],
    messages: {
      badPath: PATH_MSG,
      badCommand: COMMAND_MSG
    }
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const name = node.name.name;
        const isPath = PATH_ATTRS.has(name);
        const isCommand = COMMAND_ATTRS.has(name);
        if (!isPath && !isCommand) return;
        if (!node.value) {
          context.report({
            node: asNode(node),
            messageId: isCommand ? "badCommand" : "badPath"
          });
          return;
        }
        if (node.value.type === "Literal") {
          const v = node.value.value;
          if (typeof v !== "string") {
            context.report({
              node: asNode(node.value),
              messageId: isCommand ? "badCommand" : "badPath"
            });
            return;
          }
          if (isCommand) {
            const ok = COMMAND.test(v) || PATH.test(v) || v.startsWith("move\u2192") || v.startsWith("move>");
            if (!ok) {
              context.report({ node: asNode(node.value), messageId: "badCommand" });
            }
            return;
          }
          if (!PATH.test(v)) {
            context.report({ node: asNode(node.value), messageId: "badPath" });
          }
          return;
        }
        if (node.value.type === "JSXExpressionContainer" && node.value.expression.type !== "JSXEmptyExpression") {
          return;
        }
        context.report({
          node: asNode(node.value),
          messageId: isCommand ? "badCommand" : "badPath"
        });
      }
    };
  }
};
var valid_active_attr_default = rule3;

// src/eslint/index.ts
var rules = {
  "no-hooks-in-files": no_hooks_in_files_default,
  "no-string-keys": no_string_keys_default,
  "valid-active-attr": valid_active_attr_default
};
var plugin = {
  meta: {
    name: "@calvinjs/active-state",
    version: "0.1.0"
  },
  rules
};
var recommended = [
  {
    name: "active-state/recommended",
    plugins: {
      "active-state": plugin
    },
    rules: {
      "active-state/no-string-keys": "error",
      "active-state/valid-active-attr": "error"
    }
  }
];
function publicPages(options) {
  if (!options?.files?.length) {
    throw new Error(
      "[active-state/eslint] publicPages({ files }) requires at least one glob, e.g. ['app/(marketing)/**/*.{js,jsx,ts,tsx}']."
    );
  }
  return [
    {
      name: "active-state/public-pages",
      files: options.files,
      plugins: {
        "active-state": plugin
      },
      rules: {
        "active-state/no-hooks-in-files": "error"
      }
    }
  ];
}
var configs = {
  recommended,
  publicPages
};
var pluginWithConfigs = {
  ...plugin,
  configs
};
var eslint_default = pluginWithConfigs;
export {
  configs,
  eslint_default as default,
  plugin,
  publicPages,
  recommended,
  rules
};
