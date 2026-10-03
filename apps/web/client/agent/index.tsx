"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { get, set, subscribe } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { creditSlotRef } from "client/globe/credit-slot";
import { AGENT_CARD, SELECTION, VOICE } from "client/state";
import type { AgentCardState, AgentTab, SheetSnap } from "client/state/agent";
import type { SelectionState } from "client/state/selection";
import { startVoice, stopVoice } from "client/voice/voice-runtime";

import ChatPane, { type ChatVoice } from "./ChatPane";
import { openEvidence } from "./chat/effects";
import { isWorking } from "./chat/thread";
import { useAgentChat } from "./chat/useAgentChat";
import { Column, CreditSlot, Header, ResizeHandle, SheetHandle, Tab, TabPanel, Tabs, UnreadDot } from "./column.styled";
import {
  clampColumnWidth,
  COLUMN_DEFAULT_PX,
  COLUMN_MAX_PX,
  COLUMN_MIN_PX,
  COLUMN_WIDTH_STORAGE_KEY,
  motionMs,
  nextSnap,
  parseStoredWidth,
  prefersReducedMotion,
  SHEET_MS,
  SHEET_QUERY,
  sheetHeight,
  snapSheet,
  transitionFor,
  widthForKey,
} from "./layout/geometry";
import { agentActivity, markActivity, openTab } from "./layout/unread";
import { agentPhase, voiceIsLive } from "./phase";
import QuestionsPanel from "./QuestionsPanel";

/** The second tab lists every question the agent supports. */
const TAB_LABEL: Record<AgentTab, string> = { agent: "Agent", questions: "Questions" };
const TABS: readonly AgentTab[] = ["agent", "questions"];
/** A handle press that moves less than this is a tap (cycle snaps), not a drag. */
const TAP_SLOP_PX = 6;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the setting lasts for this page only.
  }
}

function subscribeQuery(query: string) {
  return (cb: () => void) => {
    const mq = window.matchMedia(query);
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  };
}
const subscribeSheet = subscribeQuery(SHEET_QUERY);
const subscribeViewport = (cb: () => void) => {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
};

/** Phone layout (bottom sheet) or desktop (column). False on the server; the CSS decides the first paint. */
function useSheetLayout(): boolean {
  return useSyncExternalStore(subscribeSheet, () => window.matchMedia(SHEET_QUERY).matches, () => false);
}

function useViewport(): { width: number; height: number } {
  const key = useSyncExternalStore(subscribeViewport, () => `${window.innerWidth}x${window.innerHeight}`, () => "0x0");
  const [width, height] = key.split("x").map(Number);
  return { width: width!, height: height! };
}

const card = (): AgentCardState => ({ ...AGENT_CARD.defaults, ...get<AgentCardState>(AGENT_CARD) });

function writeCard(update: (prev: AgentCardState) => AgentCardState): void {
  set<AgentCardState>(AGENT_CARD, (prev) => update({ ...AGENT_CARD.defaults, ...prev }));
}

export function selectTab(tab: AgentTab): void {
  writeCard((prev) => openTab(prev, tab));
}

export function setSheet(sheet: SheetSnap): void {
  writeCard((prev) => (prev.sheet === sheet ? prev : { ...prev, sheet }));
}

/**
 * Unread dot: the Questions tab never has news; the Agent tab lights when an answer (typed or voice) finishes while the
 * Questions tab is showing. The first signature is the baseline.
 */
function useUnreadTracking(agentSignature: string): void {
  const last = useRef<string | null>(null);
  useEffect(() => {
    const previous = last.current;
    if (agentSignature === previous) return;
    const state = card();
    const unread = markActivity(state, "agent", previous, agentSignature);
    if (unread !== state.unread) writeCard((prev) => ({ ...prev, unread }));
    last.current = agentSignature;
  }, [agentSignature]);
}

/**
 * The chat column (PRD §12 "Layout", T40): always open left of the globe, with Agent and Questions tabs. The
 * Agent tab is the field agent's thread and composer (typed and voice), the Questions tab every question it supports. The
 * right edge drags (or arrow-keys) between 360 and 560 px, remembered per browser. Under 768 px it becomes a
 * bottom sheet over the globe: a composer bar when collapsed, dragged or tapped up to half or full height.
 */
export default function AgentColumn() {
  const [state] = useActiveState<AgentCardState>(AGENT_CARD);
  const ui = { ...AGENT_CARD.defaults, ...state };
  const [voice] = useActiveState<ChatVoice>(VOICE);
  const [selected] = useActiveState<SelectionState, string | null>(SELECTION, (s) => s?.evidenceId ?? null);
  const chat = useAgentChat();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sheetLayout = useSheetLayout();
  const viewport = useViewport();
  const [storedWidth, setStoredWidth] = useState(COLUMN_DEFAULT_PX);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [reduced, setReduced] = useState(false);

  const phase = agentPhase(voice, isWorking(chat.thread));
  useUnreadTracking(agentActivity(chat.thread));

  // Browser-only settings, read after hydration so server and client render the same first frame.
  useEffect(() => {
    queueMicrotask(() => {
      setStoredWidth(parseStoredWidth(readStorage(COLUMN_WIDTH_STORAGE_KEY)));
      setReduced(prefersReducedMotion());
    });
  }, []);

  // Phones show one sheet at a time: the evidence drawer (inside the globe pane) wins while it opens.
  useEffect(() => {
    if (!sheetLayout) return;
    let wasOpen = get<SelectionState>(SELECTION)?.drawerOpen === true && Boolean(get<SelectionState>(SELECTION)?.evidenceId);
    return subscribe(SELECTION, (value) => {
      const s = value as SelectionState | undefined;
      const open = Boolean(s?.evidenceId) && s?.drawerOpen !== false;
      if (open && !wasOpen) setSheet("collapsed");
      wasOpen = open;
    });
  }, [sheetLayout]);

  const toggleVoice = useCallback(() => {
    if (voiceIsLive(voice)) stopVoice();
    else void startVoice();
  }, [voice]);

  // ---- desktop width ----------------------------------------------------------------------------------------
  const width = clampColumnWidth(dragWidth ?? storedWidth, viewport.width || undefined);
  const commitWidth = (px: number) => {
    const next = clampColumnWidth(px);
    setStoredWidth(next);
    writeStorage(COLUMN_WIDTH_STORAGE_KEY, String(next));
  };
  const resizeDrag = useRef<{ x: number; width: number } | null>(null);
  const onResizeDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeDrag.current = { x: event.clientX, width };
    setDragWidth(width);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current;
    if (drag) setDragWidth(clampColumnWidth(drag.width + event.clientX - drag.x, window.innerWidth));
  };
  const onResizeUp = () => {
    if (!resizeDrag.current) return;
    resizeDrag.current = null;
    if (dragWidth !== null) commitWidth(dragWidth);
    setDragWidth(null);
  };
  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = widthForKey(width, event.key, window.innerWidth);
    if (next === null) return;
    event.preventDefault();
    commitWidth(next);
  };

  // ---- phone sheet ------------------------------------------------------------------------------------------
  const snapHeight = sheetHeight(ui.sheet, viewport.height);
  const sheetDrag = useRef<{ y: number; height: number; lastY: number; lastT: number; velocity: number; moved: boolean } | null>(null);
  const onSheetDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    sheetDrag.current = { y: event.clientY, height: snapHeight, lastY: event.clientY, lastT: event.timeStamp, velocity: 0, moved: false };
  };
  const onSheetMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = sheetDrag.current;
    if (!drag) return;
    const dy = drag.y - event.clientY;
    if (!drag.moved && Math.abs(dy) < TAP_SLOP_PX) return;
    drag.moved = true;
    const dt = event.timeStamp - drag.lastT;
    if (dt > 0) drag.velocity = (drag.lastY - event.clientY) / dt;
    drag.lastY = event.clientY;
    drag.lastT = event.timeStamp;
    setDragHeight(Math.min(sheetHeight("full", viewport.height), Math.max(sheetHeight("collapsed", viewport.height), drag.height + dy)));
  };
  const onSheetUp = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = sheetDrag.current;
    sheetDrag.current = null;
    if (!drag) return;
    if (!drag.moved) setSheet(nextSnap(ui.sheet));
    else setSheet(snapSheet(drag.height + drag.y - event.clientY, drag.velocity, viewport.height));
    setDragHeight(null);
  };
  const onSheetKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const order: SheetSnap[] = ["collapsed", "half", "full"];
    const i = order.indexOf(ui.sheet);
    if (event.key === "ArrowUp") setSheet(order[Math.min(order.length - 1, i + 1)]!);
    else if (event.key === "ArrowDown") setSheet(order[Math.max(0, i - 1)]!);
    else return;
    event.preventDefault();
  };

  const compact = sheetLayout && ui.sheet === "collapsed" && dragHeight === null;
  const agentShown = ui.tab === "agent" || compact;
  // The dock's height for the HUD's popovers, which stop above it (client/hud/topbar).
  const sheetPx = sheetLayout ? (dragHeight ?? snapHeight) : null;
  useEffect(() => {
    const root = document.documentElement.style;
    if (sheetPx === null) root.removeProperty("--chat-sheet-h");
    else root.setProperty("--chat-sheet-h", `${sheetPx}px`);
  }, [sheetPx]);
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--chat-sheet-h");
    },
    [],
  );
  const sheetStyle = sheetLayout
    ? { height: dragHeight ?? snapHeight, transition: dragHeight === null ? transitionFor("height", motionMs(SHEET_MS, reduced)) : "none" }
    : undefined;

  return (
    <Column
      aria-label="Chat"
      data-chat-column=""
      data-layout={sheetLayout ? "sheet" : "column"}
      data-sheet={sheetLayout ? ui.sheet : undefined}
      data-motion-ms={sheetLayout ? motionMs(SHEET_MS, reduced) : undefined}
      style={{ ["--column-w" as string]: `${width}px`, ...sheetStyle }}
    >
      {sheetLayout ? (
        <SheetHandle
          type="button"
          aria-label={`Chat sheet: ${ui.sheet}. Drag or press to resize`}
          data-sheet-handle=""
          onPointerDown={onSheetDown}
          onPointerMove={onSheetMove}
          onPointerUp={onSheetUp}
          onPointerCancel={() => {
            sheetDrag.current = null;
            setDragHeight(null);
          }}
          onKeyDown={onSheetKey}
        />
      ) : null}
      {sheetLayout ? <CreditSlot ref={creditSlotRef} role="group" aria-label="Map data attribution" data-credit-slot="" /> : null}
      {compact ? null : (
        <Header data-chat-header="">
          <Tabs role="tablist" aria-label="Chat column" data-tabs="">
            {TABS.map((tab) => (
              <Tab
                key={tab}
                type="button"
                role="tab"
                id={`chat-tab-${tab}`}
                aria-controls={`chat-panel-${tab}`}
                aria-selected={ui.tab === tab}
                tabIndex={ui.tab === tab ? 0 : -1}
                data-tab={tab}
                data-unread={ui.unread[tab] ? "" : undefined}
                onClick={() => selectTab(tab)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const next = TABS[(TABS.indexOf(tab) + 1) % TABS.length]!;
                  selectTab(next);
                  document.getElementById(`chat-tab-${next}`)?.focus();
                }}
              >
                {TAB_LABEL[tab]}
                {ui.unread[tab] ? <UnreadDot aria-label="new activity" role="img" /> : null}
              </Tab>
            ))}
          </Tabs>
          {sheetLayout ? null : <CreditSlot ref={creditSlotRef} role="group" aria-label="Map data attribution" data-credit-slot="" />}
        </Header>
      )}
      <TabPanel role="tabpanel" id="chat-panel-agent" aria-labelledby="chat-tab-agent" hidden={!agentShown} data-tabpanel="agent">
        <ChatPane
          thread={chat.thread}
          asking={chat.asking}
          phase={phase}
          voice={voice}
          selected={selected ?? null}
          inputRef={inputRef}
          onSend={chat.send}
          onStop={chat.stop}
          onClear={chat.clear}
          onCite={openEvidence}
          onToggleVoice={toggleVoice}
          onMoreQuestions={() => selectTab("questions")}
          onComposerFocus={() => {
            if (!sheetLayout) return;
            writeCard((prev) => ({ ...openTab(prev, "agent"), sheet: prev.sheet === "collapsed" ? "half" : prev.sheet }));
          }}
          compact={compact}
        />
      </TabPanel>
      <TabPanel role="tabpanel" id="chat-panel-questions" aria-labelledby="chat-tab-questions" hidden={ui.tab !== "questions" || compact} data-tabpanel="questions">
        <QuestionsPanel
          asking={chat.asking}
          onAsk={(question) => {
            selectTab("agent");
            void chat.send(question);
          }}
        />
      </TabPanel>
      {sheetLayout ? null : (
        <ResizeHandle
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat column"
          aria-valuenow={width}
          aria-valuemin={COLUMN_MIN_PX}
          aria-valuemax={COLUMN_MAX_PX}
          tabIndex={0}
          data-column-resize=""
          data-dragging={dragWidth !== null ? "" : undefined}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onKeyDown={onResizeKey}
          onDoubleClick={() => commitWidth(COLUMN_DEFAULT_PX)}
        />
      )}
    </Column>
  );
}
