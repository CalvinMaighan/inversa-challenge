/**
 * @file Keep `shared/**` runtime-neutral. Ported from big-value.
 *
 * shared/ holds the contracts that the browser, the web workers, the Next server routes and the Rust API
 * mirror (feed state, EVF frames, agent events, voice protocol). A React import here drags a UI runtime into
 * a worker or route; a Node built-in drags a server runtime into the browser. Both fail the lint instead.
 */
import { builtinModules } from "node:module";

import { sourceAreaForFilename } from "./source-areas.mjs";

const NODE_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

/** Globals that exist only in one runtime. `self`, `crypto` and `DataView` are fine: every runtime has them. */
const RUNTIME_GLOBALS = ["Buffer", "Bun", "process", "window", "document", "localStorage", "navigator", "WebSocket", "indexedDB"];

/** @returns {string | null} why `source` is impure, or null when it is fine. */
export function impurity(source) {
  const bare = source.replace(/^node:/, "");
  if (NODE_MODULES.has(bare)) return "Node.js built-in";
  if (source === "server-only") return "server-only marker";
  if (source === "react" || source.startsWith("react/")) return "React runtime";
  if (source === "react-dom" || source.startsWith("react-dom/")) return "React DOM runtime";
  if (source === "next" || source.startsWith("next/")) return "Next.js runtime";
  return null;
}

/** True when the identifier is a static member/object/type name, not a reference to a global. */
export function isStaticNamePosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "MemberExpression":
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
    case "TSPropertySignature":
    case "TSMethodSignature":
    case "TSEnumMember":
      return parent.key === node ? !parent.computed : parent.property === node && !parent.computed;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return parent.label === node;
    case "ExportSpecifier":
      return parent.exported === node;
    default:
      return false;
  }
}

/** True when a local binding (const/let/var/function/class/param/import) shadows the global name. */
function isShadowed(node, sourceCode) {
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(node.name);
    if (variable) return variable.defs.length > 0;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export const sharedPurityRule = {
  meta: {
    type: "problem",
    docs: { description: "Keep shared modules runtime-neutral" },
    schema: [],
    messages: {
      impureSharedImport:
        "shared/ cannot import '{{source}}' ({{kind}}). Move the runtime-specific code to client/ or server/ and keep only pure contracts in shared/.",
      impureSharedGlobal:
        "shared/ cannot use the '{{name}}' runtime global. Move this implementation to client/ or server/.",
    },
  },

  create(context) {
    const cwd = typeof context.cwd === "string" ? context.cwd : context.getCwd();
    if (sourceAreaForFilename(context.filename, cwd)?.area !== "shared") return {};

    function checkSource(node) {
      if (!node || node.type !== "Literal" || typeof node.value !== "string") return;
      const kind = impurity(node.value);
      if (!kind) return;
      context.report({ node, messageId: "impureSharedImport", data: { source: node.value, kind } });
    }

    return {
      ImportDeclaration: (node) => checkSource(node.source),
      ExportNamedDeclaration: (node) => checkSource(node.source),
      ExportAllDeclaration: (node) => checkSource(node.source),
      ImportExpression: (node) => checkSource(node.source),
      // `source` is the current property; `argument` is the deprecated alias kept for older parsers.
      TSImportType: (node) => checkSource(node.source ?? node.argument),
      "CallExpression[callee.name='require']": (node) => checkSource(node.arguments[0]),
      Identifier(node) {
        if (!RUNTIME_GLOBALS.includes(node.name)) return;
        if (isStaticNamePosition(node)) return;
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        if (isShadowed(node, sourceCode)) return;
        context.report({ node, messageId: "impureSharedGlobal", data: { name: node.name } });
      },
    };
  },
};

export default sharedPurityRule;
