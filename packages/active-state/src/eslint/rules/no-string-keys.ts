import type { Rule } from "eslint";

const MSG =
  "[active-state] Pass a key() slice (e.g. LAYOUT or LAYOUT.nav), not a string literal. " +
  'Define the key with key("LAYOUT", defaults), export it from your catalog, import that const, ' +
  "and use it here so TypeScript and agents stay aligned.";

const API = new Set([
  "get",
  "set",
  "subscribe",
  "useActiveState",
  "useClientState",
  "useLocalState",
  "clearPersisted",
  "clearLocalStateKey",
  "resolveKey",
]);

const PKG = /^(active-state)(\/.*)?$/;

function isStringLiteral(node: unknown): boolean {
  return (
    !!node &&
    typeof node === "object" &&
    (node as { type?: string }).type === "Literal" &&
    typeof (node as { value?: unknown }).value === "string"
  );
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require key() slices instead of string literals for active-state APIs.",
    },
    schema: [],
    messages: {
      useKeySlice: MSG,
    },
  },
  create(context) {
    /** local binding → api name */
    const locals = new Map<string, string>();
    /** namespace import local (import * as AS from 'active-state') */
    const namespaces = new Set<string>();

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
            const imported =
              spec.imported.type === "Identifier" ? spec.imported.name : null;
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
            node: node.arguments[0]!,
            messageId: "useKeySlice",
          });
          return;
        }

        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.object.type === "Identifier" &&
          namespaces.has(callee.object.name) &&
          callee.property.type === "Identifier" &&
          API.has(callee.property.name)
        ) {
          context.report({
            node: node.arguments[0]!,
            messageId: "useKeySlice",
          });
        }
      },
    };
  },
};

export default rule;

