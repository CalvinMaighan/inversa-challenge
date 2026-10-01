import AgentColumn from "client/agent";
import Globe from "client/globe";
import Hud from "client/hud";
import MissionsPanel from "client/hud/missions";
import AppShell from "client/ui/AppShell";

/** Ops view (T40): the chat column (Agent | Missions) on the left, the globe and its HUD on the right. */
export default function Page() {
  return <AppShell side={<AgentColumn missions={<MissionsPanel />} />} globe={<Globe />} hud={<Hud />} />;
}
