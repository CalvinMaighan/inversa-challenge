import { notFound } from "next/navigation";

import DevAgent from "./DevAgent";

/** The env check below must run per request, not once at build time. */
export const dynamic = "force-dynamic";

/**
 * Scratch route for the chat column (T14/T40 e2e): the column in the app shell with no globe or HUD, talking to the
 * real agent. `?at=<ISO>` moves the replay window to that instant (the eval fixtures live in January 2026).
 * Dev server only.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { at } = await searchParams;
  return <DevAgent at={typeof at === "string" ? at : null} />;
}
