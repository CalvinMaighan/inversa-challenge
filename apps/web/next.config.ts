import path from "node:path";

import type { NextConfig } from "next";

/** Monorepo root: bun hoists node_modules there, so Turbopack and output tracing must see it. */
const REPO_ROOT = path.join(__dirname, "../..");

/** Axum listens on loopback; Next proxies /v1 in dev so the browser stays same-origin. Caddy does this in prod. */
const API_ORIGIN = process.env.INVERSA_API_ORIGIN ?? "http://127.0.0.1:4041";

/**
 * Cross-origin isolation for SharedArrayBuffer (PRD section 12; Safari lacks `credentialless`, so require-corp),
 * plus the response hardening deploy/Caddyfile applies in production, so dev and e2e behave the same without
 * Caddy in front. docs/security.md explains each one.
 */
const securityHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
];

const nextConfig: NextConfig = {
  turbopack: { root: REPO_ROOT },
  outputFileTracingRoot: REPO_ROOT,
  /* The agent harness reads its plugin tree at runtime; tracing cannot see the file read. */
  outputFileTracingIncludes: { "/api/agent/**": ["./server/agent/cordis/cordis.yml"] },
  output: "standalone",
  poweredByHeader: false,
  /* Next dev refuses its own assets to hosts other than localhost; allow the loopback IP too. */
  allowedDevOrigins: ["127.0.0.1"],
  compiler: { emotion: true },
  /*
   * Always defined, so the bundler inlines it: unset, Next leaves `process.env.NEXT_PUBLIC_INVERSA_E2E` as a
   * runtime lookup and the `window.__inversa` hook (client/debug.ts) ships dead in production chunks. As "" the
   * guard folds to false and the minifier drops the hook.
   */
  env: { NEXT_PUBLIC_INVERSA_E2E: process.env.NEXT_PUBLIC_INVERSA_E2E ?? "" },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${API_ORIGIN}/v1/:path*` }];
  },
};

export default nextConfig;
