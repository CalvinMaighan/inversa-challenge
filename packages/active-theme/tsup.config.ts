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
    entry: { "lite/index": "src/lite/index.ts" },
    format: ["esm"],
    dts: true,
    splitting: false,
    clean: false,
    external: ["active-theme"],
    target: "es2020",
    esbuildOptions(options) {
      options.alias = { "active-theme": coreEntry };
    },
  },
  {
    entry: { "react/index": "src/react/index.ts" },
    format: ["esm"],
    dts: true,
    splitting: false,
    clean: false,
    external: ["react", "react/jsx-runtime", "active-theme"],
    target: "es2020",
    banner: { js: '"use client";' },
    esbuildOptions(options) {
      options.alias = { "active-theme": coreEntry };
    },
  },
  {
    entry: { "state/index": "src/state/index.ts" },
    format: ["esm"],
    dts: true,
    splitting: false,
    clean: false,
    external: [
      "react",
      "react/jsx-runtime",
      "@calvinjs/active-state",
      "@calvinjs/active-state/react",
      "active-theme",
    ],
    target: "es2020",
    banner: { js: '"use client";' },
    esbuildOptions(options) {
      options.alias = { "active-theme": coreEntry };
    },
  },
  {
    entry: { "emotion/index": "src/emotion/index.ts" },
    format: ["esm"],
    dts: true,
    splitting: false,
    clean: false,
    external: ["active-theme", "@emotion/react"],
    target: "es2020",
    esbuildOptions(options) {
      options.alias = { "active-theme": coreEntry };
    },
  },
]);
