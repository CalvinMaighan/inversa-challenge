/** Command-line parsing for eval/run.ts, kept apart so tests can import it without running the eval. */

import { APP_IDS, isAppId, type AppId } from "@/shared/apps";

/** `--app=<id>` or `--app <id>` beats `EVAL_APP`; python by default. */
export function evalApp(argv: readonly string[], env: Record<string, string | undefined>): AppId {
  const eq = argv.find((a) => a.startsWith("--app="))?.slice("--app=".length);
  const at = argv.indexOf("--app");
  const raw = eq ?? (at >= 0 ? argv[at + 1] : undefined) ?? env.EVAL_APP ?? "python";
  if (!isAppId(raw)) throw new Error(`unknown app "${raw}" (apps: ${APP_IDS.join(", ")})`);
  return raw;
}

/** `--runs=N` or `--runs N`; 1 by default. */
export function evalRuns(argv: readonly string[]): number {
  const eq = argv.find((a) => a.startsWith("--runs="))?.slice("--runs=".length);
  const at = argv.indexOf("--runs");
  const raw = eq ?? (at >= 0 ? argv[at + 1] : undefined) ?? "1";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--runs must be a positive integer, got "${raw}"`);
  return n;
}
