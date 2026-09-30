import type { Rule } from "eslint";

const HOOK = /^use[A-Z]/;

const MSG =
  "[active-state] React hooks are not allowed in this file (public/static surface). " +
  'Keep it a Server Component, or move interactivity into a small "use client" island outside this lint path. ' +
  "Shared UI state: define key() in a catalog, import { state } from that catalog, " +
  "mount <ActiveState init={state} ssr />, then call useActiveState(KEY) / ActiveState.set(KEY, …) " +
  "only inside that client island.";

function isHookName(name: string | null | undefined): boolean {
  return typeof name === "string" && HOOK.test(name);
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow React hooks in configured public/static files (agent guardrail).",
    },
    schema: [],
    messages: {
      noHooks: MSG,
    },
  },
  create(context) {
    return {
      ImportSpecifier(node) {
        if (
          node.parent.type === "ImportDeclaration" &&
          typeof node.parent.source.value === "string" &&
          (node.parent.source.value === "react" ||
            node.parent.source.value.startsWith("react/")) &&
          isHookName(node.imported.type === "Identifier" ? node.imported.name : null)
        ) {
          context.report({ node, messageId: "noHooks" });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier" && isHookName(callee.name)) {
          context.report({ node, messageId: "noHooks" });
          return;
        }
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          isHookName(callee.property.name)
        ) {
          context.report({ node, messageId: "noHooks" });
        }
      },
    };
  },
};

export default rule;

