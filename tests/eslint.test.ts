import { RuleTester } from "eslint";
import { describe, expect, test } from "bun:test";
import { publicPages, recommended } from "../src/eslint";
import noHooksInFiles from "../src/eslint/rules/no-hooks-in-files";
import noStringKeys from "../src/eslint/rules/no-string-keys";
import validActiveAttr from "../src/eslint/rules/valid-active-attr";


const jsxTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe("eslint plugin configs", () => {
  test("exports recommended + publicPages", () => {
    expect(recommended.length).toBe(1);
    const pub = publicPages({
      files: ["app/(marketing)/**/*.{js,jsx,ts,tsx}"],
    });
    expect(pub[0]?.rules?.["active-state/no-hooks-in-files"]).toBe("error");
  });

  test("publicPages requires files", () => {
    expect(() => publicPages({ files: [] })).toThrow(/requires at least one glob/);
  });
});


// RuleTester owns its own describe/it — must run at module scope for bun:test.
jsxTester.run("no-hooks-in-files", noHooksInFiles, {
  valid: [
    { code: `export default function Page() { return <main />; }` },
    { code: `import { ActiveState } from "active-state/react";` },
  ],
  invalid: [
    {
      code: `import { useState } from "react";\nexport function X() { return useState(0); }`,
      errors: [{ messageId: "noHooks" }, { messageId: "noHooks" }],
    },
    {
      code: `export function X() { return React.useEffect(() => {}, []); }`,
      errors: [{ messageId: "noHooks" }],
    },
  ],
});

jsxTester.run("no-string-keys", noStringKeys, {
  valid: [
    {
      code: `
        import { get } from "active-state";
        import { LAYOUT } from "./keys";
        get(LAYOUT);
      `,
    },
    {
      code: `
        import { key } from "active-state";
        key("LAYOUT", { nav: false });
      `,
    },
    {
      code: `
        import { get as lodashGet } from "lodash";
        lodashGet(obj, "a.b");
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { get } from "active-state";
        get("LAYOUT");
      `,
      errors: [{ messageId: "useKeySlice" }],
    },
    {
      code: `
        import { ActiveState } from "active-state/react";
        ActiveState.set("LAYOUT.nav", true);
      `,
      errors: [{ messageId: "useKeySlice" }],
    },
    {
      code: `
        import { useActiveState } from "active-state/react";
        useActiveState("LAYOUT");
      `,
      errors: [{ messageId: "useKeySlice" }],
    },
  ],
});

jsxTester.run("valid-active-attr", validActiveAttr, {
  valid: [
    { code: `<span active-text="LAYOUT.nav" />` },
    { code: `<span active-text="card.title" />` },
    { code: `<span active-text={LAYOUT.nav} />` },
    { code: `<button type="button" active-toggle="LAYOUT.nav" />` },
    { code: `<button active-click="toggle:THEME.dark" />` },
    { code: `<section active-drop="move→col.cards" />` },
  ],
  invalid: [
    {
      code: `<span active-text="LAYOUT-nav" />`,
      errors: [{ messageId: "badPath" }],
    },
    {
      code: `<button active-click="LAYOUT.nav++" />`,
      errors: [{ messageId: "badCommand" }],
    },
  ],
});
