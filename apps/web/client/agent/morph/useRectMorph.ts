"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { measureElementRect, type ElementRect } from "./geometry";
import { morphTiming, prefersReducedMotion } from "./timing";

/**
 * Enter/exit choreography for a rect morph, ported from deedee `useRectMorph`: fade in at the source's size,
 * morph to the target rect, fade the content in; the reverse on close. Under reduced motion the card opens
 * and closes in place with no beats.
 */

export type RectMorphStage = "idle" | "fade-in" | "morph-out" | "content-in" | "open" | "content-out" | "morph-in" | "fade-out";

export type CloseReason = "keyboard" | "pointer" | "parent";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Two frames, so a style set before this has painted before the next one starts a transition. */
function doubleRaf(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export type UseRectMorphOptions = {
  open: boolean;
  sourceRef: RefObject<HTMLElement | null>;
  computeTarget: (source: ElementRect) => ElementRect;
  /** Called once the exit finished; the parent flips `open` off here. */
  onClose: (reason: CloseReason) => void;
  onOpened?: () => void;
};

export type RectMorphState = {
  stage: RectMorphStage;
  session: number;
  displayRect: ElementRect | null;
  /** Morph beat running: top/left/width/height transition. */
  animating: boolean;
  panelVisible: boolean;
  panelFade: boolean;
  contentVisible: boolean;
  contentFade: boolean;
  /** Durations of the current run (0 under reduced motion). */
  fadeMs: number;
  morphMs: number;
  interactive: boolean;
  requestClose: (reason?: CloseReason) => void;
};

export function useRectMorph({ open, sourceRef, computeTarget, onClose, onOpened }: UseRectMorphOptions): RectMorphState {
  const [stage, setStage] = useState<RectMorphStage>("idle");
  const [session, setSession] = useState(0);
  const [displayRect, setDisplayRect] = useState<ElementRect | null>(null);
  const [animating, setAnimating] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const [panelFade, setPanelFade] = useState(false);
  const [contentVisible, setContentVisible] = useState(false);
  const [contentFade, setContentFade] = useState(false);
  const [timing, setTiming] = useState(() => morphTiming(false));
  const runId = useRef(0);
  const closing = useRef(false);
  const closeReason = useRef<CloseReason>("parent");
  const sourceRect = useRef<ElementRect | null>(null);
  const targetRect = useRef<ElementRect | null>(null);
  const onCloseRef = useRef(onClose);
  const onOpenedRef = useRef(onOpened);
  const computeTargetRef = useRef(computeTarget);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    onOpenedRef.current = onOpened;
    computeTargetRef.current = computeTarget;
  });

  const measure = useCallback(() => {
    const el = sourceRef.current;
    if (!el) return null;
    const source = measureElementRect(el);
    return { source, target: computeTargetRef.current(source) };
  }, [sourceRef]);

  const finish = useCallback(() => {
    runId.current += 1;
    closing.current = false;
    sourceRect.current = null;
    targetRect.current = null;
    setStage("idle");
    setDisplayRect(null);
    setAnimating(false);
    setPanelVisible(false);
    setPanelFade(false);
    setContentVisible(false);
    setContentFade(false);
    onCloseRef.current(closeReason.current);
  }, []);

  const requestClose = useCallback(
    (reason: CloseReason = "pointer") => {
      if (closing.current) return;
      if (stage === "idle" || stage === "content-out" || stage === "morph-in" || stage === "fade-out") return;
      closing.current = true;
      closeReason.current = reason;
      setStage("content-out");
    },
    [stage],
  );

  // Open: measure the orb and start the enter beats.
  useLayoutEffect(() => {
    if (!open || stage !== "idle") return;
    const rects = measure();
    if (!rects) return;
    sourceRect.current = rects.source;
    targetRect.current = rects.target;
    closing.current = false;
    closeReason.current = "parent";
    // Measure-then-render is what layout effects are for: the orb's rect only exists after commit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTiming(morphTiming(prefersReducedMotion()));
    setSession((n) => n + 1);
    setDisplayRect(rects.source);
    setStage("fade-in");
  }, [open, stage, measure]);

  // Parent closed while open (state reset elsewhere): play the exit.
  useEffect(() => {
    if (open || stage === "idle" || closing.current) return;
    closing.current = true;
    closeReason.current = "parent";
    setStage("content-out");
  }, [open, stage]);

  useEffect(() => {
    if (stage === "idle") return;
    const id = ++runId.current;
    const alive = () => id === runId.current;
    const reduced = prefersReducedMotion();
    const { fadeMs, morphMs } = morphTiming(reduced);

    const run = async () => {
      switch (stage) {
        case "fade-in": {
          const target = targetRect.current;
          if (!target) return;
          if (reduced) {
            setDisplayRect(target);
            setPanelVisible(true);
            setContentVisible(true);
            setStage("open");
            return;
          }
          // Beat 1: fade in at the orb's size.
          setPanelFade(false);
          setPanelVisible(false);
          setContentVisible(false);
          setAnimating(false);
          await doubleRaf();
          if (!alive()) return;
          setPanelFade(true);
          setPanelVisible(true);
          await wait(fadeMs);
          if (alive()) setStage("morph-out");
          return;
        }
        case "morph-out": {
          const target = targetRect.current;
          if (!target) return;
          // Beat 2: morph orb → card.
          setAnimating(false);
          await doubleRaf();
          if (!alive()) return;
          setAnimating(true);
          setDisplayRect(target);
          await wait(morphMs);
          if (alive()) setStage("content-in");
          return;
        }
        case "content-in": {
          // Beat 3: fade the content in.
          setAnimating(false);
          setContentFade(false);
          setContentVisible(false);
          await doubleRaf();
          if (!alive()) return;
          setContentFade(true);
          setContentVisible(true);
          await wait(fadeMs);
          if (alive()) setStage("open");
          return;
        }
        case "open":
          onOpenedRef.current?.();
          return;
        case "content-out": {
          if (reduced) {
            finish();
            return;
          }
          setContentFade(false);
          setContentVisible(true);
          await doubleRaf();
          if (!alive()) return;
          setContentFade(true);
          setContentVisible(false);
          await wait(fadeMs);
          if (alive()) setStage("morph-in");
          return;
        }
        case "morph-in": {
          // The orb may have moved (resize, safe area): morph back to where it is now.
          const live = measure();
          const backTo = live?.source ?? sourceRect.current;
          if (!backTo) {
            finish();
            return;
          }
          setAnimating(false);
          await doubleRaf();
          if (!alive()) return;
          setAnimating(true);
          setDisplayRect(backTo);
          await wait(morphMs);
          if (alive()) setStage("fade-out");
          return;
        }
        case "fade-out": {
          setAnimating(false);
          setPanelFade(false);
          await doubleRaf();
          if (!alive()) return;
          setPanelFade(true);
          setPanelVisible(false);
          await wait(fadeMs);
          if (alive()) finish();
          return;
        }
        default:
          return;
      }
    };
    void run();
  }, [stage, measure, finish]);

  useEffect(() => {
    if (stage === "idle") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      requestClose("keyboard");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, requestClose]);

  // Keep the card placed while open: rotation, resize, on-screen keyboard.
  useEffect(() => {
    if (stage !== "open") return;
    const onResize = () => {
      const rects = measure();
      if (!rects) return;
      sourceRect.current = rects.source;
      targetRect.current = rects.target;
      setDisplayRect(rects.target);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [stage, measure]);

  return {
    stage,
    session,
    displayRect,
    animating,
    panelVisible,
    panelFade,
    contentVisible,
    contentFade,
    fadeMs: timing.fadeMs,
    morphMs: timing.morphMs,
    interactive: stage === "open",
    requestClose,
  };
}
