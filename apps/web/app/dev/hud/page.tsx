import { notFound } from "next/navigation";

import { devRoutesEnabled } from "server/dev-routes";

import HudFixture from "client/hud/dev/HudFixture";

/** Read the flag per request, not at build: the same build serves production (off) and e2e (on). */
export const dynamic = "force-dynamic";

/**
 * HUD scratch route: the real HUD over 96 fixture frames in a SAB frame grid, with no API behind it.
 * Used by `bun run e2e:scrub` and for the gap-hatching screenshot. Off unless `INVERSA_DEV_ROUTES=1`.
 */
export default function HudDevPage() {
  if (!devRoutesEnabled()) notFound();
  return <HudFixture />;
}
