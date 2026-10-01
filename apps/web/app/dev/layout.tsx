import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { devRoutesEnabled } from "server/dev-routes";

/** Evaluated per request (the flag is read at run time, not baked at build). */
export const dynamic = "force-dynamic";

/** Guards every `/dev/*` page, including ones added later (server/dev-routes.ts). Route handlers guard themselves. */
export default function DevLayout({ children }: { children: ReactNode }) {
  if (!devRoutesEnabled()) notFound();
  return children;
}
