import { preloadModule } from "react-dom";

import AgentColumn from "client/agent";
import Globe from "client/globe";
import { CESIUM_BASE_URL } from "client/globe/cesium";
import Hud from "client/hud";
import { AppScope } from "client/hud/appselect/AppBoot";
import Intro from "client/intro/Intro";
import StageShell from "client/hud/shell/StageShell";

/**
 * Ops view (T40, docs/GODS_EYE.md GC1): a black page with the globe in a centred circular stage, the chat card
 * (Agent | Questions) floating at the left, the HUD over the page with the sighting card at the right. Phones keep
 * the docked sheets. The chat card and the HUD remount per app (`AppScope`, PLAN.md C-A5); the globe stays and
 * follows the app's view and layers.
 */
export default function Page() {
  // Cesium (4.7 MB, imported at runtime by the client-only globe) starts downloading and compiling with the HTML
  // instead of after hydration (docs/perf.md, cold load).
  preloadModule(`${CESIUM_BASE_URL}/index.js`, { as: "script" });
  return (
    <>
      <StageShell
        side={
          <AppScope>
            <AgentColumn />
          </AppScope>
        }
        globe={<Globe />}
        hud={
          <AppScope>
            <Hud />
          </AppScope>
        }
      />
      {/* First-run gate: choose a species, then the microphone (docs/intro.md). Hidden by `?intro=0`. */}
      <Intro />
    </>
  );
}
