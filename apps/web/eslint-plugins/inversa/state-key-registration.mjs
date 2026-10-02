/**
 * @file Every active-state key must be registered in the `catalog(...)` call. Ported from big-value.
 *
 * `client/state/index.ts` builds the single store from an explicit list of keys, and that list also fixes the
 * SAB transport's key indices (PLAN.md C6). A key that is created and exported but never passed to
 * `catalog(...)` still works in isolation, so a missing registration shows up late: a value that never
 * persists, never hydrates, or has no index on the ring. This rule makes it fail at lint.
 */
import fs from "node:fs";
import path from "node:path";

import { repoRelative } from "./source-areas.mjs";

const STATE_DIR = "client/state";
const REGISTRY = "client/state/index.ts";
const REGISTRY_CALL = /catalog\(([\s\S]*?)\)\s*;/;

/**
 * Names passed to `catalog(...)` in the registry file, or null when it cannot be read.
 * @param {string} cwd
 * @returns {Set<string> | null}
 */
export function registeredStateKeys(cwd = process.cwd()) {
  let source;
  try {
    source = fs.readFileSync(path.join(cwd, REGISTRY), "utf8");
  } catch {
    return null;
  }
  const call = REGISTRY_CALL.exec(source);
  if (!call) return null;
  return new Set(
    call[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

/** True when the linted file is a state slice that must register its keys. */
export function ownsStateKeys(filename, cwd = process.cwd()) {
  const relative = repoRelative(filename, cwd);
  if (!relative || relative === REGISTRY) return false;
  return relative.startsWith(`${STATE_DIR}/`);
}

/** @type {import('eslint').Rule.RuleModule} */
export const stateKeyRegistrationRule = {
  meta: {
    type: "problem",
    docs: { description: "active-state keys must be registered in client/state/index.ts" },
    schema: [],
    messages: {
      unregisteredKey:
        'State key "{{name}}" is never registered. Add it to the catalog(...) call in client/state/index.ts, or it will not persist, hydrate, or get a transport index.',
      unknownRegistry:
        "Could not read the catalog(...) registration list in client/state/index.ts, so state keys cannot be verified.",
    },
  },

  create(context) {
    const cwd = typeof context.cwd === "string" ? context.cwd : context.getCwd();
    if (!ownsStateKeys(context.filename, cwd)) return {};
    const registered = registeredStateKeys(cwd);
    if (!registered) {
      return {
        Program(node) {
          context.report({ node, messageId: "unknownRegistry" });
        },
      };
    }

    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.init?.type !== "CallExpression") return;
        if (node.init.callee.type !== "Identifier" || node.init.callee.name !== "key") return;
        if (!registered.has(node.id.name)) {
          context.report({ node, messageId: "unregisteredKey", data: { name: node.id.name } });
        }
      },
    };
  },
};

export default stateKeyRegistrationRule;
