import { preloadModule } from "react-dom";

import AgentColumn from "client/agent";
import Globe from "client/globe";
import { CESIUM_BASE_URL } from "client/globe/cesium";
import Hud from "client/hud";
import MissionsPanel from "client/hud/missions";
import AppShell from "client/ui/AppShell";

/** Ops view (T40): the chat column (Agent | Missions) on the left, the globe and its HUD on the right. */
export default function Page() {
  // Cesium (4.7 MB, imported at runtime by the client-only globe) starts downloading and compiling with the HTML
  // instead of after hydration (docs/perf.md, cold load).
  preloadModule(`${CESIUM_BASE_URL}/index.js`, { as: "script" });
  return <AppShell side={<AgentColumn missions={<MissionsPanel />} />} globe={<Globe />} hud={<Hud />} />;
}
