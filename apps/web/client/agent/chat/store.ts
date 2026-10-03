import { set } from "@calvinjs/active-state";

import { AGENT_CHAT } from "client/state";

import { asThread, reduceThread, type AgentThread, type ThreadAction } from "./thread";

/** Apply one action to the transcript in AGENT_CHAT: the typed chat, the voice and the agent's cards all write through here. */
export function dispatchThread(action: ThreadAction): void {
  set<AgentThread>(AGENT_CHAT, (prev) => reduceThread(asThread(prev), action));
}
