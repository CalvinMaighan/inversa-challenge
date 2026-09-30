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
      "active-state/react": path.join(lib, "dist/react/index.js"),
      "active-state/dom": path.join(lib, "dist/dom/index.js"),
      "active-state": path.join(lib, "dist/index.js"),
    },
  },
});
