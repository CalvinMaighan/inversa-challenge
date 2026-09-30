import { notFound } from "next/navigation";

import DevGlobe from "./DevGlobe";

/** Read the flag per request, not at build: the same build serves production (off) and e2e (on). */
export const dynamic = "force-dynamic";

/**
 * Globe scratch route: the real Cesium globe alone, with layer toggles, a scrubber and `window.__globe`
 * diagnostics. Used by `bun run e2e:globe` (isolation, COEP errors, idle frames). On under `next dev`; in a
 * production build only with `INVERSA_DEV_ROUTES=1`.
 */
export default function DevGlobePage() {
  if (process.env.NODE_ENV === "production" && process.env.INVERSA_DEV_ROUTES !== "1") notFound();
  return <DevGlobe />;
}
