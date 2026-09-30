import path from "node:path";

import type { NextConfig } from "next";

/** Monorepo root: bun hoists node_modules there, so Turbopack and output tracing must see it. */
const REPO_ROOT = path.join(__dirname, "../..");

/** Axum listens on loopback; Next proxies /v1 in dev so the browser stays same-origin. Caddy does this in prod. */
const API_ORIGIN = process.env.INVERSA_API_ORIGIN ?? "http://127.0.0.1:4041";

/** Cross-origin isolation for SharedArrayBuffer (PRD section 12). Safari lacks `credentialless`, so require-corp. */
const isolationHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];

const nextConfig: NextConfig = {
  turbopack: { root: REPO_ROOT },
  outputFileTracingRoot: REPO_ROOT,
  /* The agent harness reads its plugin tree at runtime; tracing cannot see the file read. */
  outputFileTracingIncludes: { "/api/agent/**": ["./server/agent/cordis/cordis.yml"] },
  output: "standalone",
  poweredByHeader: false,
  compiler: { emotion: true },
  async headers() {
    return [{ source: "/:path*", headers: isolationHeaders }];
  },
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${API_ORIGIN}/v1/:path*` }];
  },
};

export default nextConfig;
