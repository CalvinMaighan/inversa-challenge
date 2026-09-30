"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "../card.styled";
import { CloseIcon } from "../icons";
import { PanelBox } from "./DataPanels";
import { focusPanel } from "./effects";
import { expandedPanelRect, type Rect } from "./model";
import { Floating, FloatingBody, FloatingHead, Stack } from "./panels.styled";
import { useTurnPanels } from "./store";

/** Attribute the card's click-away check skips, so using this panel does not collapse the card. */
export const AGENT_OVERLAY_ATTR = "data-agent-overlay";

function subscribeResize(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

const viewportKey = () => `${window.innerWidth}x${window.innerHeight}`;

function cardRect(): Rect | null {
  const el = document.querySelector("[data-agent-card]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * The wide data panel: every panel of one answer, about 640 px wide, docked left of the chat card and clear of
 * the globe centre; a full-screen sheet on phones. Esc or the close button returns to the card.
 */
export default function ExpandedPanels({ turnId, onClose }: { turnId: string; onClose: () => void }) {
  const panels = useTurnPanels(turnId);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const viewport = useSyncExternalStore(subscribeResize, viewportKey, () => "");
  // The card is placed (open) before its Expand button can be pressed; re-placed on every resize.
  const rect = useMemo(() => {
    const [width, height] = viewport.split("x").map(Number);
    const card = viewport ? cardRect() : null;
    return card && width && height ? expandedPanelRect(card, { width, height }) : null;
  }, [viewport]);

  useEffect(() => {
    // The card's own Esc handler runs on window; claiming the key here keeps the card open.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!rect || panels.length === 0 || typeof document === "undefined") return null;

  const toggle = (key: string) => {
    const panel = panels.find((p) => p.key === key);
    if (closed.has(key) && panel) focusPanel(turnId, panel);
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return createPortal(
    <Floating
      {...{ [AGENT_OVERLAY_ATTR]: "" }}
      $sheet={rect.sheet}
      role="dialog"
      aria-label="Result data"
      data-expanded-panels=""
      data-sheet={rect.sheet ? "" : undefined}
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
    >
      <FloatingHead>
        <span>Result data · {panels.length}</span>
        <IconButton type="button" aria-label="Close data panel" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </FloatingHead>
      <FloatingBody>
        <Stack>
          {panels.map((panel) => (
            <PanelBox key={panel.key} panel={panel} turnId={turnId} open={!closed.has(panel.key)} wide onToggle={(p) => toggle(p.key)} />
          ))}
        </Stack>
      </FloatingBody>
    </Floating>,
    document.body,
  );
}
