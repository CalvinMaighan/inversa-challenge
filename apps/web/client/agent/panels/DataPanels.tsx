"use client";

import { useState } from "react";

import { ExpandIcon } from "../icons";
import { focusPanel } from "./effects";
import { panelSummary, primaryPanelIndex, type Panel } from "./model";
import { Body, Box, Head, HeadTitle, Kind, Stack, StackHead, Summary, TextButton } from "./panels.styled";
import { useTurnPanels } from "./store";
import { PanelView } from "./views";

const KIND_LABEL: Record<Panel["view"]["view"], string> = {
  table: "table",
  series: "chart",
  cells: "cells",
  explain: "why",
  backtest: "test",
  feeds: "feeds",
};

export function PanelBox({
  panel,
  turnId,
  open,
  wide,
  onToggle,
}: {
  panel: Panel;
  turnId: string;
  open: boolean;
  wide: boolean;
  onToggle: (panel: Panel) => void;
}) {
  return (
    <Box $open={open} data-panel={panel.view.view} data-panel-tool={panel.capabilityName} data-open={open ? "" : undefined}>
      <Head type="button" aria-expanded={open} onClick={() => onToggle(panel)} title={panel.view.title}>
        <Kind>{KIND_LABEL[panel.view.view]}</Kind>
        <HeadTitle>{panel.view.title}</HeadTitle>
        <Summary>{panelSummary(panel.view)}</Summary>
      </Head>
      {open ? (
        <Body>
          <PanelView view={panel.view} turnId={turnId} wide={wide} />
        </Body>
      ) : null}
    </Box>
  );
}

/**
 * Result panels under an assistant answer (PLAN.md C17), one per tool view, collapsible. The most relevant one
 * starts open; opening a panel frames its area on the globe. Expand pops them out into the wide panel.
 */
export default function DataPanels({ turnId, onExpand }: { turnId: string; onExpand: (turnId: string) => void }) {
  const panels = useTurnPanels(turnId);
  // undefined: follow the most relevant panel as results arrive; null: the reader closed everything.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  if (panels.length === 0) return null;
  const openKey = chosen === undefined ? (panels[primaryPanelIndex(panels)]?.key ?? null) : chosen;

  const toggle = (panel: Panel) => {
    if (panel.key === openKey) {
      setChosen(null);
      return;
    }
    setChosen(panel.key);
    focusPanel(turnId, panel);
  };

  return (
    <Stack aria-label="Result data" data-panels={panels.length}>
      <StackHead>
        <span>Data · {panels.length}</span>
        <TextButton type="button" onClick={() => onExpand(turnId)} aria-label="Expand data panels" data-expand-panels="">
          <ExpandIcon /> Expand
        </TextButton>
      </StackHead>
      {panels.map((panel) => (
        <PanelBox key={panel.key} panel={panel} turnId={turnId} open={panel.key === openKey} wide={false} onToggle={toggle} />
      ))}
    </Stack>
  );
}
