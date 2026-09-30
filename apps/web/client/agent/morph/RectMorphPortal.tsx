"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { rectToCss, SHEET_BREAKPOINT, type ElementRect } from "./geometry";
import { Content, Panel } from "./morph.styled";
import { useRectMorph, type CloseReason } from "./useRectMorph";

/** Rects at most this wide are the orb: drawn as a circle so the morph starts and ends on its shape. */
const ORB_SIZE_MAX = 72;

export type RectMorphPortalProps = {
  open: boolean;
  sourceRef: RefObject<HTMLElement | null>;
  computeTarget: (source: ElementRect) => ElementRect;
  label: string;
  onClose: (reason: CloseReason) => void;
  onOpened?: () => void;
  children: (api: { interactive: boolean; requestClose: (reason?: CloseReason) => void }) => ReactNode;
};

/**
 * Ported from deedee `RectMorphPortal`: the panel lives in a body portal and morphs between the source
 * element's rect and `computeTarget(source)`. Esc and a pointer press outside both the panel and the source
 * collapse it back onto the source.
 */
export default function RectMorphPortal({ open, sourceRef, computeTarget, label, onClose, onOpened, children }: RectMorphPortalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const morph = useRectMorph({ open, sourceRef, computeTarget, onClose, onOpened });
  const { stage, session, displayRect, interactive, requestClose } = morph;

  useEffect(() => {
    if (!interactive) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || sourceRef.current?.contains(target)) return;
      requestClose("pointer");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [interactive, requestClose, sourceRef]);

  if (stage === "idle" || !displayRect || typeof document === "undefined") return null;

  const css = rectToCss(displayRect);
  const orbSized = css.width <= ORB_SIZE_MAX && css.height <= ORB_SIZE_MAX;
  const sheet = !orbSized && typeof window !== "undefined" && window.innerWidth < SHEET_BREAKPOINT;

  return createPortal(
    <Panel
      key={session}
      ref={panelRef}
      role="dialog"
      aria-label={label}
      data-agent-card=""
      data-stage={stage}
      data-sheet={sheet ? "" : undefined}
      $animating={morph.animating}
      $fade={morph.panelFade}
      $visible={morph.panelVisible}
      $fadeMs={morph.fadeMs}
      $morphMs={morph.morphMs}
      style={{
        top: css.top,
        left: css.left,
        width: css.width,
        height: css.height,
        borderRadius: orbSized ? Math.round(Math.min(css.width, css.height) / 2) : undefined,
      }}
    >
      <Content $visible={morph.contentVisible} $fade={morph.contentFade} $fadeMs={morph.fadeMs}>
        {children({ interactive, requestClose })}
      </Content>
    </Panel>,
    document.body,
  );
}
