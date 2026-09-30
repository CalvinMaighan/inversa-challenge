/**
 * @file A `"use client"` module must stay browser-safe. Ported from big-value.
 *
 * The directive moves a module (and everything it imports) into the browser bundle. A Node built-in, a
 * server/ module (agent, voice relay: they hold the Fireworks and xAI keys), or a non-`NEXT_PUBLIC_` env read
 * either breaks the build or ships a secret. `shared-purity` guards the contract layer the same way.
 */
import { builtinModules } from "node:module";
import path from "node:path";

import { importedTarget, physicalFilename } from "./source-areas.mjs";

const NODE_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

/** Next.js request-scoped APIs; a client module cannot read cookies or headers. */
const SERVER_NEXT_APIS = new Set(["next/headers", "next/cookies", "next/server"]);

/** Env vars Next.js inlines into the browser bundle besides `NEXT_PUBLIC_*`. */
const BROWSER_ENV = new Set(["NODE_ENV"]);

/**
 * Why a `"use client"` module may not import `source`, or null when the import is browser-safe.
 * @returns {string | null}
 */
export function serverOnlyReason(source, fileDir, cwd = process.cwd()) {
  if (typeof source !== "string" || !source) return null;
  if (NODE_MODULES.has(source.replace(/^node:/, ""))) return "a Node.js built-in";
  if (SERVER_NEXT_APIS.has(source)) return "a Next.js server API";
  if (source === "server-only") return "the server-only marker";
  if (source.startsWith("@aws-sdk/")) return "a server-only package";
  const target = importedTarget(source, fileDir, cwd);
  if (!target) return null;
  if (target === "server" || target.startsWith("server/")) return "a server-only module";
  if (target.startsWith("app/api/")) return "a route handler";
  return null;
}

/** True when the member expression is exactly `process.env`. */
function isProcessEnv(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.property?.type === "Identifier" &&
    node.property.name === "env" &&
    node.object?.type === "Identifier" &&
    node.object.name === "process"
  );
}

/**
 * The literal env-var name of a `process.env.X` / `process.env["X"]` read, or null for anything else
 * (including `process.env` alone and a dynamic name that cannot be checked statically).
 */
export function envNameOf(node) {
  if (node?.type !== "MemberExpression" || !isProcessEnv(node.object)) return null;
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "string") return node.property.value;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export const useClientPurityRule = {
  meta: {
    type: "problem",
    docs: { description: 'A "use client" module must not import server-only code or read private env vars' },
    schema: [],
    messages: {
      serverOnlyImport:
        'A "use client" module cannot import "{{source}}" ({{kind}}). It would ship server code, or a secret, to the browser. Call an app/api route instead.',
      unsafeEnv:
        'A "use client" module cannot read process.env.{{name}}. Next.js only inlines NEXT_PUBLIC_* into the browser bundle; read it in a route handler instead.',
    },
  },

  create(context) {
    let client = false;
    const fileDir = path.dirname(physicalFilename(context.filename));
    const cwd = typeof context.cwd === "string" ? context.cwd : context.getCwd();

    function checkSource(sourceNode) {
      if (!sourceNode || sourceNode.type !== "Literal" || typeof sourceNode.value !== "string") return;
      const kind = serverOnlyReason(sourceNode.value, fileDir, cwd);
      if (!kind) return;
      context.report({ node: sourceNode, messageId: "serverOnlyImport", data: { source: sourceNode.value, kind } });
    }

    return {
      Program(node) {
        client = node.body?.[0]?.type === "ExpressionStatement" && node.body[0].directive === "use client";
      },
      ImportDeclaration(node) {
        if (client && node.importKind !== "type") checkSource(node.source);
      },
      ExportNamedDeclaration(node) {
        if (client && node.exportKind !== "type") checkSource(node.source);
      },
      ExportAllDeclaration(node) {
        if (client && node.exportKind !== "type") checkSource(node.source);
      },
      ImportExpression(node) {
        if (client) checkSource(node.source);
      },
      MemberExpression(node) {
        if (!client) return;
        const name = envNameOf(node);
        if (!name || name.startsWith("NEXT_PUBLIC_") || BROWSER_ENV.has(name)) return;
        context.report({ node, messageId: "unsafeEnv", data: { name } });
      },
    };
  },
};

export default useClientPurityRule;
