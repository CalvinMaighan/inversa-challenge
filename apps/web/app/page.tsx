import { preloadModule } from "react-dom";

import AgentColumn from "client/agent";
import Globe from "client/globe";
import { CESIUM_BASE_URL } from "client/globe/cesium";
import Hud from "client/hud";
import { AppScope } from "client/hud/appselect/AppBoot";
import MissionsPanel from "client/hud/missions";
import AppShell from "client/ui/AppShell";

/**
 * Ops view (T40): the chat column (Agent | Missions) on the left, the globe and its HUD on the right. The column
 * and the HUD remount per app (`AppScope`, PLAN.md C-A5); the globe stays and follows the app's view and layers.
 */
export default function Page() {
  // Cesium (4.7 MB, imported at runtime by the client-only globe) starts downloading and compiling with the HTML
  // instead of after hydration (docs/perf.md, cold load).
  preloadModule(`${CESIUM_BASE_URL}/index.js`, { as: "script" });
  return (
    <AppShell
      side={
        <AppScope>
          <AgentColumn missions={<MissionsPanel />} />
        </AppScope>
      }
      globe={<Globe />}
      hud={
        <AppScope>
          <Hud />
        </AppScope>
      }
    />
  );
}
