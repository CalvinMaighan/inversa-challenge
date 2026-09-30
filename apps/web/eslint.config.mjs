import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { recommended } from "@calvinjs/active-state/eslint";

import { configs as inversa } from "./eslint-plugins/inversa/plugin.mjs";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  ...recommended,
  ...inversa,
  globalIgnores([".next/**", ".cache/**", "public/cesium/**", "public/sqlite-wasm/**", "next-env.d.ts"]),
]);
