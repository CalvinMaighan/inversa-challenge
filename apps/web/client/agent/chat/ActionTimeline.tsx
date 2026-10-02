"use client";

import { useEffect, useState } from "react";

import { Timeline, TimelineLabel, TimelineRow, TimelineRows } from "../chat.styled";
import { formatWorkDuration, groupDetail, groupLabel, groupState, groupTools, toolLabel, turnWorkMs } from "./tools";
import type { AgentTurn } from "./thread";

/** Re-render once a second while `active`, for the live "Working for" clock. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Tool timeline for one assistant turn (deedee `ActionTimeline` / `TimelineRow`): rows stream in while the
 * agent works, then fold under "Worked for Xs" with repeat calls grouped per capability.
 */
export default function ActionTimeline({ turn }: { turn: AgentTurn }) {
  const working = turn.status === "streaming";
  const [open, setOpen] = useState(false);
  const now = useNow(working);
  const tools = turn.tools ?? [];
  if (!tools.length) return null;

  const { groups, running } = groupTools(tools);
  const ms = turnWorkMs(turn, now);
  const expanded = working || open;
  const failed = groups.some((g) => groupState(g) === "error");

  return (
    <Timeline data-timeline="">
      <TimelineLabel
        type="button"
        $state={failed && !working ? "error" : "ok"}
        $expandable={!working}
        aria-expanded={working ? undefined : open}
        disabled={working}
        onClick={() => setOpen((v) => !v)}
        data-timeline-toggle=""
      >
        {working ? `Working for ${formatWorkDuration(ms, true)}` : `Worked for ${formatWorkDuration(ms, false)}`}
      </TimelineLabel>
      {expanded ? (
        <TimelineRows aria-label="Tools the agent ran">
          {groups.map((group) => {
            const detail = groupDetail(group);
            return (
              <TimelineRow key={group.capabilityName} $state={groupState(group)} data-tool-row={group.capabilityName}>
                {groupLabel(group)}
                {detail ? <small>{detail}</small> : null}
              </TimelineRow>
            );
          })}
          {running.map((tool) => (
            <TimelineRow key={tool.toolCallId} $state="running" data-tool-row={tool.capabilityName}>
              {toolLabel(tool)}
            </TimelineRow>
          ))}
        </TimelineRows>
      ) : null}
    </Timeline>
  );
}
