/**
 * What the first turn after a server boot would otherwise pay for inside its first-token time: the harness
 * mount (plugin tree, model entry) and the TLS connection to OpenRouter (DNS, handshake). Measured on the perf
 * pass: the first question of a fresh server reached its first model output about 700 ms later than the next
 * ones. Called once when the agent route module loads; a failure is left to the turn, which reports it.
 */
import { bootHarness } from "@/server/agent/cordis/boot";
import { OPENROUTER_BASE_URL, openRouterApiKey } from "@/server/agent/runtime/model";

let warmed: Promise<void> | undefined;

export function warmAgent(): Promise<void> {
  warmed ??= (async () => {
    await bootHarness().catch(() => undefined);
    if (!openRouterApiKey()) return;
    // A HEAD to the API root opens the keep-alive connection the streaming requests reuse; the answer is ignored.
    await fetch(`${OPENROUTER_BASE_URL}/models`, { method: "HEAD", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  })();
  return warmed;
}
