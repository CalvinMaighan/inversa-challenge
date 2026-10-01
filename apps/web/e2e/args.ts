/**
 * `--app <id>` / `--app=<id>` for the per-app e2e scripts (docs/grading/rubric.json runs each one with
 * `-- --app {app}`). An unknown id throws; no flag gives `fallback`.
 */
import { isAppId, type AppId } from "../shared/apps";

export function appArg(fallback: AppId = "python", argv: readonly string[] = process.argv.slice(2)): AppId {
  const eq = argv.find((a) => a.startsWith("--app="))?.slice("--app=".length);
  const at = argv.indexOf("--app");
  const raw = eq ?? (at >= 0 ? (argv[at + 1] ?? "") : fallback);
  if (!isAppId(raw)) throw new Error(`--app ${raw}: not an app id`);
  return raw;
}
