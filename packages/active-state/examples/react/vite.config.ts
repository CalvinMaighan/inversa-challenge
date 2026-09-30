import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const lib = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export default defineConfig({
  plugins: [react()],
  server: { port: 5179 },
  resolve: {
    alias: {
      "@calvinjs/active-state/react": path.join(lib, "dist/react/index.js"),
      "@calvinjs/active-state/dom": path.join(lib, "dist/dom/index.js"),
      "@calvinjs/active-state": path.join(lib, "dist/index.js"),
    },
  },
});
