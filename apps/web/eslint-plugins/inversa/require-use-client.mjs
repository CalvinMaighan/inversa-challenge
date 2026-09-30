/**
 * @file Every component under `client/ui/` must declare its client boundary. Ported from big-value.
 *
 * `"use client"` is what tells Next.js to render the module in the browser. Without it a component that
 * touches hooks, refs, or browser APIs is evaluated as a server component, and the mistake surfaces at
 * runtime as a hook error rather than at lint. The directive has to be the first statement to count.
 */
import { repoRelative } from "./source-areas.mjs";

/** The interactive component tree; everything here is a client module by convention. */
const UI_DIR = "client/ui";

/** True when the file lives under `client/ui/`. */
export function isClientUiFile(filename, cwd = process.cwd()) {
  const relative = repoRelative(filename, cwd);
  return Boolean(relative && relative.startsWith(`${UI_DIR}/`));
}

/** True when the program's directive prologue opens with `"use client"`. */
export function hasUseClientDirective(program) {
  const first = program?.body?.[0];
  return first?.type === "ExpressionStatement" && first.directive === "use client";
}

/** @type {import('eslint').Rule.RuleModule} */
export const requireUseClientRule = {
  meta: {
    type: "problem",
    docs: { description: 'Components under client/ui/ must start with the "use client" directive' },
    schema: [],
    messages: {
      missingUseClient:
        'client/ui/ components are client modules: add "use client"; as the first line. Without it Next.js renders the file on the server and hooks or browser APIs fail at runtime.',
    },
  },

  create(context) {
    const cwd = typeof context.cwd === "string" ? context.cwd : context.getCwd();
    if (!isClientUiFile(context.filename, cwd)) return {};
    return {
      Program(node) {
        if (hasUseClientDirective(node)) return;
        context.report({ node, messageId: "missingUseClient" });
      },
    };
  },
};

export default requireUseClientRule;
