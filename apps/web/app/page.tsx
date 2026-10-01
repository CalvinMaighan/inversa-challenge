import { preloadModule } from "react-dom";

import AgentOrb from "client/agent";
import Globe from "client/globe";
import { CESIUM_BASE_URL } from "client/globe/cesium";
import Hud from "client/hud";
import MissionsPanel from "client/hud/missions";
import AppShell from "client/ui/AppShell";

/** Ops view: full-bleed globe, tactical HUD on top, agent orb bottom-right (PLAN.md C16). */
export default function Page() {
  // Cesium (4.7 MB, imported at runtime by the client-only globe) starts downloading and compiling with the HTML
  // instead of after hydration (docs/perf.md, cold load).
  preloadModule(`${CESIUM_BASE_URL}/index.js`, { as: "script" });
  return <AppShell globe={<Globe />} hud={<Hud missions={<MissionsPanel />} />} orb={<AgentOrb />} />;
}
