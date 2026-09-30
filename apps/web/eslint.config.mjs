import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { recommended } from "@calvinjs/active-state/eslint";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  ...recommended,
  globalIgnores([".next/**", ".cache/**", "public/cesium/**", "next-env.d.ts"]),
]);
