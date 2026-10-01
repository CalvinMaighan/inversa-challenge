"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "../chat.styled";
import { CloseIcon } from "../icons";
import { motionMs, POPOUT_MS, prefersReducedMotion } from "../layout/geometry";
import { PanelBox } from "./DataPanels";
import { focusPanel } from "./effects";
import { expandedPanelRect, type Rect } from "./model";
import { Floating, FloatingBody, FloatingHead, Stack } from "./panels.styled";
import { useTurnPanels } from "./store";

/** The globe pane the app shell lays out right of the chat column (client/ui/AppShell). */
export const GLOBE_PANE_SELECTOR = '[data-slot="globe-pane"]';

function paneElement(): Element | null {
  return document.querySelector(GLOBE_PANE_SELECTOR);
}

/** Window resizes and pane resizes (dragging the column's edge moves the pane without a window resize). */
function subscribeLayout(cb: () => void): () => void {
  window.addEventListener("resize", cb);
  const pane = paneElement();
  const observer = pane && typeof ResizeObserver === "function" ? new ResizeObserver(cb) : null;
  if (pane) observer?.observe(pane);
  return () => {
    window.removeEventListener("resize", cb);
    observer?.disconnect();
  };
}

function layoutKey(): string {
  const r = paneElement()?.getBoundingClientRect();
  return `${window.innerWidth}x${window.innerHeight}|${r ? `${r.left},${r.top},${r.width},${r.height}` : ""}`;
}

/**
 * The wide data panel: every panel of one answer, up to 640 px wide, over the left part of the globe pane next
 * to the chat column and clear of the pane centre; a full-screen sheet on phones. Esc or the close button
 * returns to the thread.
 */
export default function ExpandedPanels({ turnId, onClose }: { turnId: string; onClose: () => void }) {
  const panels = useTurnPanels(turnId);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const layout = useSyncExternalStore(subscribeLayout, layoutKey, () => "");
  const rect = useMemo(() => {
    if (!layout) return null;
    const [size, box] = layout.split("|");
    const [width, height] = size!.split("x").map(Number);
    const [left, top, w, h] = (box ?? "").split(",").map(Number);
    const pane: Rect = box ? { left: left!, top: top!, width: w!, height: h! } : { left: 0, top: 0, width: width!, height: height! };
    return width && height ? expandedPanelRect(pane, { width, height }) : null;
  }, [layout]);
  const [ms] = useState(() => motionMs(POPOUT_MS, prefersReducedMotion()));

  useEffect(() => {
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
      $sheet={rect.sheet}
      $ms={ms}
      role="dialog"
      aria-label="Result data"
      data-expanded-panels=""
      data-sheet={rect.sheet ? "" : undefined}
      data-motion-ms={ms}
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
