import AgentOrb from "client/agent";
import Globe from "client/globe";
import Hud from "client/hud";
import MissionsPanel from "client/hud/missions";
import AppShell from "client/ui/AppShell";

/** Ops view: full-bleed globe, tactical HUD on top, agent orb bottom-right (PLAN.md C16). */
export default function Page() {
  return <AppShell globe={<Globe />} hud={<Hud missions={<MissionsPanel />} />} orb={<AgentOrb />} />;
}
