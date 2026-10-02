import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { DSH_HOME_ENV, resolveDshHome } from "@deepseek-ai/dsh-home-paths";

import { dataDir } from "@/server/agent/config";

/** Harness home under the data dir, which is gitignored. */
export function agentDshHome(): string {
  return join(dataDir(), "dsh");
}

/** Pin `$DSH_HOME` for this process unless the operator set one. */
export function ensureAgentDshHome(): string {
  if (!process.env[DSH_HOME_ENV]?.trim()) {
    process.env[DSH_HOME_ENV] = agentDshHome();
  }
  const home = resolveDshHome(undefined, process.env);
  mkdirSync(home, { recursive: true });
  return home;
}
