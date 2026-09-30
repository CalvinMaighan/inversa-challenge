import path from "node:path";
import { defineConfig } from "tsup";

const coreEntry = path.resolve("src/core/index.ts");

export default defineConfig([
  {
    entry: { index: "src/core/index.ts" },
    format: ["esm"],
    dts: true,
    splitting: false,
    clean: true,
    target: "es2020",
  },
  {
    entry: { "dom/index": "src/dom/index.ts" },
    format: ["esm"],
    dts: true,
    splitting: false,
    clean: false,
    external: ["active-state"],
    target: "es2020",
  },
  {
    entry: { "react/index": "src/react/index.ts" },
    format: ["esm"],
    dts: true,
    splitting: false,
    clean: false,
    external: [
      "react",
      "react/jsx-runtime",
      "active-state",
      "active-state/dom",
    ],
    target: "es2020",
    banner: { js: '"use client";' },
  },
  {
    entry: { "eslint/index": "src/eslint/index.ts" },
    format: ["esm"],
    dts: true,
    splitting: false,
    clean: false,
    external: ["eslint"],
    target: "es2020",
  },
  {
    entry: { "active-state.min": "src/browser.ts" },
    format: ["iife"],
    globalName: "ActiveState",
    minify: true,
    dts: false,
    target: "es2020",
    outExtension: () => ({ js: ".js" }),
    esbuildOptions(options) {
      options.alias = {
        "active-state": coreEntry,
      };
    },
  },
]);
