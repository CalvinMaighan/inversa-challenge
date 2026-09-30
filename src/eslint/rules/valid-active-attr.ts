import type { Rule } from "eslint";

/** Absolute KEY or relative each-alias paths */
const PATH =
  /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** verb:path or verb:path:payload / move→path */
const COMMAND =
  /^(toggle|set|push|remove|move)(:|→|>)[A-Za-z_][\w.]*([\s\S]*)$/;

const PATH_ATTRS = new Set([
  "active-text",
  "active-show",
  "active-model",
  "active-toggle",
  "active-drag",
  "active-each",
  "active-as",
]);

const COMMAND_ATTRS = new Set([
  "active-click",
  "active-submit",
  "active-drop",
]);

const PATH_MSG =
  "[active-state] Path must look like KEY.field or each-alias.field " +
  '(e.g. "LAYOUT.nav" or "card.title").';

const COMMAND_MSG =
  "[active-state] Use verb:path (no JS expressions). " +
  'Examples: active-click="toggle:THEME.dark", active-click=\'set:THEME.mode:"dark"\', ' +
  'active-drop="move→col.cards", active-submit="push:col.cards".';

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Validate active-* path / command attrs (agent guardrail).",
    },
    schema: [],
    messages: {
      badPath: PATH_MSG,
      badCommand: COMMAND_MSG,
    },
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
            node,
            messageId: isCommand ? "badCommand" : "badPath",
          });
          return;
        }

        if (node.value.type === "Literal") {
          const v = node.value.value;
          if (typeof v !== "string") {
            context.report({
              node: node.value,
              messageId: isCommand ? "badCommand" : "badPath",
            });
            return;
          }
          if (isCommand) {
            // allow move→path or bare path (bind prefixes move)
            const ok =
              COMMAND.test(v) ||
              PATH.test(v) ||
              v.startsWith("move→") ||
              v.startsWith("move>");
            if (!ok) {
              context.report({ node: node.value, messageId: "badCommand" });
            }
            return;
          }
          if (!PATH.test(v)) {
            context.report({ node: node.value, messageId: "badPath" });
          }
          return;
        }

        if (
          node.value.type === "JSXExpressionContainer" &&
          node.value.expression.type !== "JSXEmptyExpression"
        ) {
          return;
        }

        context.report({
          node: node.value,
          messageId: isCommand ? "badCommand" : "badPath",
        });
      },
    };
  },
};

export default rule;
