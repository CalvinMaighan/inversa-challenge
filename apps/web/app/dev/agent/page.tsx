import { notFound } from "next/navigation";

import DevAgent from "./DevAgent";

/**
 * Scratch route for the agent orb (T14 e2e): the orb in the app shell with no globe or HUD. `?at=<ISO>` moves
 * the replay window to that instant (the eval fixtures live in January 2026). Dev server or mock harness only.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production" && process.env.AGENT_HARNESS !== "mock") notFound();
  const { at } = await searchParams;
  return <DevAgent at={typeof at === "string" ? at : null} />;
}
