"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { get, set, subscribe } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import type { FeedState } from "shared/feed-state";

import { SHEET_MEDIA } from "client/agent/layout/geometry";
import { ALERTS_SEEN } from "client/state/alerts";
import { FEEDS } from "client/state/feeds";
import { MENU } from "client/state/menu";
import { blurOf, featherOf, LOOK, lookOf, SCOPE_BLUR, SCOPE_FEATHER, SCOPE_SHAPE, SCOPE_SIZE, shapeOf, sizeOf, type LookId, type ScopeShape } from "client/state/look";
import { THEME } from "client/state/theme";
import styled from "client/styled";
import type { MenuId } from "shared/voice/ui-tools";
import { THEME_MODES, type ThemeModeId } from "client/themes/palette";

import { hasNewData, latestMs, liveRows } from "../alerts/model";
import { Dot, Icon, IconButton, MOBILE, Surface, GLASS_CSS, POPOVER_BUTTONS_CSS } from "../primitives";
import DeveloperPanel from "../developer/DeveloperPanel";
import { LookChoices, LookIcon, setLook, setScopeBlur, setScopeFeather, setScopeShape, setScopeSize } from "../look/LookBar";
import { formatLag } from "./feed-chips";

/** An icon button's size. */
export const ROUND_PX = 36;
/** The cluster's buttons, left to right: Live data, Theme, Look, Developer. */
export const TOPBAR_BUTTONS = 5;
/** The cluster's width (the top row keeps this much room, plus a gutter, at its right). */
export const TOPBAR_WIDTH_CSS = `calc(${TOPBAR_BUTTONS * ROUND_PX}px + ${TOPBAR_BUTTONS - 1} * var(--gap-m))`;

/** The four icon buttons, pinned to the top right of the HUD's top row (which keeps room for them), one gutter apart. */
const Bar = styled.header`
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  gap: var(--gap-m);
`;

/**
 * A button and its popover: the popover opens one gutter below the button with its right edge on the button's right
 * edge. Its width leaves a gutter at the pane's left: this button sits one button and one gutter left of the
 * cluster's right end (Look, before Developer).
 */
const Anchor = styled.div`
  position: relative;
  display: flex;

  > [role="dialog"] {
    width: min(320px, calc(100cqw - 3 * var(--gap-m) - ${ROUND_PX}px));
    max-height: calc(100cqh - ${ROUND_PX}px - 3 * var(--gap-m));
  }
  ${SHEET_MEDIA} {
    > [role="dialog"] {
      max-height: max(160px, calc(100dvh - var(--chat-sheet-h, 0px) - var(--hud-top) - var(--gap-m)));
    }
  }
`;

const Round = styled(Surface.withComponent("button"))`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${ROUND_PX}px;
  height: ${ROUND_PX}px;
  padding: 0;
  border-radius: 50%;
  color: var(--text);
  cursor: pointer;

  svg {
    width: 18px;
    height: 18px;
  }

  &:hover,
  &[aria-expanded="true"] {
    border-color: var(--hud-line);
  }

  /* Feed health: a small dot on the about button, in the colour of the worst feed. */
  > span {
    position: absolute;
    top: 3px;
    right: 3px;
  }
`;

const Popover = styled.div`
  position: absolute;
  /* The HUD row lets the pointer through to the globe; the popover takes it back. */
  pointer-events: auto;
  top: calc(100% + var(--gap-m));
  right: 0;
  z-index: 9;
  width: min(340px, calc(100cqw - 2 * var(--gap-m)));
  max-height: calc(100cqh - 140px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--gap-m);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  ${GLASS_CSS}
  color: var(--text);
  font: 400 13px / 1.45 var(--font-ui);
  scrollbar-width: thin;
  ${POPOVER_BUTTONS_CSS}

  &:focus-visible {
    outline-offset: -2px;
  }

  > p {
    margin: 0 0 var(--gap-s);
  }

  details {
    margin-top: var(--gap-s);
    border-top: 1px solid var(--border);
    padding-top: var(--gap-s);
  }

  summary {
    cursor: pointer;
    color: var(--muted);
    font: 600 12px / 1.6 var(--font-ui);
  }

  ${MOBILE} {
    width: calc(100cqw - 2 * var(--gap-m));
  }

  /* Phones: the chat dock covers the bottom of the page (half or full height): the popover stops a gutter above it
     and scrolls, so nothing in it sits under the dock (the agent column writes --chat-sheet-h). */
  ${SHEET_MEDIA} {
    max-height: max(160px, calc(100dvh - var(--chat-sheet-h, 0px) - var(--hud-top) - var(--gap-m)));
  }
`;

const Choices = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;

  button {
    justify-content: flex-start;
    width: 100%;
    height: 32px;
    text-transform: none;
    letter-spacing: 0;
    font-size: 13px;
  }
`;

/**
 * A button with a popover under it. Esc (inside the popover) or a click outside closes it; Esc and the
 * popover's own actions hand focus back to the button.
 */
export function usePopover(triggerRef: RefObject<HTMLButtonElement | null>, popRef: RefObject<HTMLDivElement | null>, menu?: MenuId) {
  const [local, setLocal] = useState(false);
  const current = useSyncExternalStore(
    (cb) => subscribe(MENU, cb),
    () => get<string | null>(MENU) ?? null,
    () => null,
  );
  // A named menu lives in MENU (one open at a time, and the agent can open it); an unnamed one keeps its own state.
  const open = menu ? current === menu : local;
  const setOpen = useCallback(
    (next: boolean | ((v: boolean) => boolean)) => {
      if (!menu) return setLocal(next);
      const isOpen = get<string | null>(MENU) === menu;
      const value = typeof next === "function" ? next(isOpen) : next;
      if (value) set<string | null>(MENU, menu);
      else if (isOpen) set<string | null>(MENU, null);
    },
    [menu],
  );
  useEffect(() => {
    if (!open) return;
    popRef.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && !popRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, popRef, triggerRef, setOpen]);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  return { open, toggle: () => setOpen((v) => !v), close };
}

export function PopoverBox({ id, label, testId, popRef, onClose, children, align = "right" }: { id: string; label: string; testId: string; popRef: RefObject<HTMLDivElement | null>; onClose: () => void; children: ReactNode; align?: "left" | "right" }) {
  return (
    <Popover
      ref={popRef}
      id={id}
      style={align === "left" ? { left: 0, right: "auto" } : undefined}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-testid={testId}
      data-hud-obstacle=""
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </Popover>
  );
}

const LiveList = styled.ul`
  display: flex;
  flex-direction: column;
  gap: var(--gap-s);
  margin: var(--gap-s) 0 0;
  padding: 0;
  list-style: none;

  /* Two lines per source: its name and when it was checked, then what it checks and its newest record. */
  li {
    display: grid;
    grid-template-columns: 9px minmax(0, 1fr) auto;
    column-gap: var(--gap-s);
    row-gap: 1px;
    align-items: baseline;
  }
  li > :first-child {
    grid-row: 1 / 3;
    align-self: start;
    margin-top: 4px;
  }
  b {
    font: 600 12px / 1.3 var(--font-mono);
  }
  small {
    color: var(--muted);
    font: 400 11px / 1.3 var(--font-mono);
    white-space: nowrap;
  }
  small:nth-of-type(2) {
    white-space: normal;
  }
  small:nth-of-type(1),
  small:nth-of-type(3) {
    text-align: right;
  }
`;

/** The popover's body: every source's newest record, freshest first, ages ticking. Over plain props so it renders anywhere. */
export function LiveDataContent({ list, nowMs }: { list: FeedState[]; nowMs: number }) {
  const rows = liveRows(list, nowMs);
  return (
    <>
      <p>Live checks of each data source.</p>
      {rows.length === 0 ? (
        <p>Nothing has reported yet.</p>
      ) : (
        <LiveList aria-label="Latest data" data-testid="live-data-list">
          {rows.map((r) => (
            <li key={r.source} data-feed={r.source} title={r.fetchedMs ? `Checked ${formatLag((nowMs - r.fetchedMs) / 1000)} ago` : undefined}>
              <Dot $tone={r.state === "nominal" ? "ok" : r.state === "lagging" ? "warn" : r.state === "stale" ? "stale" : "danger"} />
              <b>{r.label}</b>
              <small>{r.checked ? `checked ${r.checked}` : "not checked"}</small>
              <small>{r.what}</small>
              <small>newest {r.age}</small>
            </li>
          ))}
        </LiveList>
      )}
    </>
  );
}

/**
 * Live data: a bell with a dot when a source has reported something newer than the viewer last saw; its popover lists the
 * newest record per source with its age. The feeds are pushed by the server every few seconds, so this is the real-time
 * view of what is coming in.
 */
function LiveData({ list, seen, onSeen }: { list: FeedState[]; seen: number; onSeen: (ms: number) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pop = usePopover(triggerRef, popRef, "live_data");
  const id = useId();
  const [now, setNow] = useState(() => Date.now());
  const latest = latestMs(list);
  // What arrives while the page loads (the feeds come in one by one) is the baseline, and so is whatever is in the open popover.
  useEffect(() => {
    const loading = typeof performance !== "undefined" && performance.now() < LOAD_BASELINE_MS;
    if (latest > 0 && (seen === 0 || loading || pop.open) && latest !== seen) onSeen(latest);
  }, [latest, seen, pop.open, onSeen]);
  useEffect(() => {
    if (!pop.open) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [pop.open]);
  const fresh = hasNewData(list, seen);
  const label = fresh ? "Live data: new data has arrived" : "Live data: the newest records from each source";
  return (
    <Anchor>
      <Round
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        aria-label={label}
        title={label}
        data-testid="live-data-button"
        data-new={fresh ? "1" : "0"}
        onClick={() => {
          setNow(Date.now());
          pop.toggle();
        }}
      >
        <Icon name="bell" />
        {fresh ? <Dot $tone="ok" $pulse /> : null}
      </Round>
      {pop.open ? (
        <PopoverBox id={id} label="Live data" testId="live-data-popover" popRef={popRef} onClose={pop.close} align="right">
          <LiveDataContent list={list} nowMs={now} />
        </PopoverBox>
      ) : null}
    </Anchor>
  );
}

/** Records that arrive in this first stretch of the page's life are already seen: only later ones light the dot. */
const LOAD_BASELINE_MS = 20_000;

const THEME_LABELS: Record<ThemeModeId, string> = { light: "Light", dark: "Dark", tactical: "Tactical" };

function Theme({ mode, onPick }: { mode: ThemeModeId; onPick: (mode: ThemeModeId) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pop = usePopover(triggerRef, popRef, "theme");
  const id = useId();
  return (
    <>
      <Round
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        aria-label="Theme"
        title="Theme"
        data-testid="theme-button"
        onClick={pop.toggle}
      >
        <Icon name="theme" />
      </Round>
      {pop.open ? (
        <PopoverBox id={id} label="Theme" testId="theme-popover" popRef={popRef} onClose={pop.close}>
          <ThemeChoices mode={mode} onPick={onPick} />
        </PopoverBox>
      ) : null}
    </>
  );
}

export function ThemeChoices({ mode, onPick }: { mode: ThemeModeId; onPick: (mode: ThemeModeId) => void }) {
  return (
    <Choices role="radiogroup" aria-label="Theme">
      {THEME_MODES.map((m) => (
        <IconButton key={m} type="button" role="radio" aria-checked={mode === m} $active={mode === m} onClick={() => onPick(m)}>
          {THEME_LABELS[m]}
        </IconButton>
      ))}
    </Choices>
  );
}

/**
 * Look (GE9): the visual presets and the map window (shape, size, soft edge), as an icon button in the cluster. Its
 * popover opens below it, right edges aligned.
 */
function Look({ look, shape, size, feather, blur }: LookState) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pop = usePopover(triggerRef, popRef, "look");
  const id = useId();
  return (
    <Anchor>
      <Round
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        aria-label="Look: filters and map window"
        title="Look: filters and map window"
        data-testid="look-button"
        onClick={pop.toggle}
      >
        <LookIcon />
      </Round>
      {pop.open ? (
        <PopoverBox id={id} label="Look" testId="look-popover" popRef={popRef} onClose={pop.close} align="right">
          <LookChoices
            look={look}
            shape={shape}
            size={size}
            feather={feather}
            blur={blur}
            onLook={setLook}
            onShape={setScopeShape}
            onSize={setScopeSize}
            onFeather={setScopeFeather}
            onBlur={setScopeBlur}
          />
        </PopoverBox>
      ) : null}
    </Anchor>
  );
}

/** Code brackets: the Developer button's icon, drawn like the HUD's own icons. */
function DeveloperIcon() {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
    </svg>
  );
}

/** Developer: opens the provider keys panel ("Power up the globe", client/hud/developer); closing it hands focus back here. */
function Developer() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menu = useSyncExternalStore(
    (cb) => subscribe(MENU, cb),
    () => get<string | null>(MENU) ?? null,
    () => null,
  );
  const open = menu === "developer";
  const setOpen = (next: boolean | ((v: boolean) => boolean)) => {
    const isOpen = get<string | null>(MENU) === "developer";
    const value = typeof next === "function" ? next(isOpen) : next;
    if (value) set<string | null>(MENU, "developer");
    else if (isOpen) set<string | null>(MENU, null);
  };
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <Round
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Developer settings: data provider keys"
        title="Developer settings"
        data-testid="developer-button"
        onClick={() => setOpen((v) => !v)}
      >
        <DeveloperIcon />
      </Round>
      {open ? <DeveloperPanel onClose={close} /> : null}
    </>
  );
}

/**
 * The globe pane's chrome (T41, GODS_EYE GC1, GE9): four icon buttons, top right, one gutter apart, and no text
 * until one opens. About (ⓘ, with a dot in the colour of the worst feed when a source is delayed) holds what this
 * is, how fresh the data is in plain words, Focus, Help, the technical feed list under "Data sources" and the expert
 * layers under "More data (for experts)". Theme holds light, dark and tactical. Look holds the visual presets and
 * the map window. Developer opens the provider keys panel.
 */
export default function TopBar(props: ChromeProps) {
  const [feeds] = useActiveState<FeedState[]>(FEEDS);
  const [mode, setMode] = useActiveState<ThemeModeId>(THEME);
  const [seen, setSeen] = useActiveState<number>(ALERTS_SEEN);
  const look: LookState = {
    look: lookOf(useActiveState<LookId>(LOOK)[0]),
    shape: shapeOf(useActiveState<ScopeShape>(SCOPE_SHAPE)[0]),
    size: sizeOf(useActiveState<number>(SCOPE_SIZE)[0]),
    feather: featherOf(useActiveState<number>(SCOPE_FEATHER)[0]),
    blur: blurOf(useActiveState<number>(SCOPE_BLUR)[0]),
  };
  return <TopBarView {...props} feeds={feeds ?? []} mode={mode ?? "dark"} onTheme={setMode} look={look} seen={seen ?? 0} onSeen={setSeen} />;
}

type ChromeProps = { focus: boolean; onFocus: (next: boolean) => void; helpOpen: boolean; onHelp: (open: boolean) => void };
/** The Look keys the Look popover shows. */
type LookState = { look: LookId; shape: ScopeShape; size: number; feather: number; blur: number };
const DEFAULT_LOOK_STATE: LookState = { look: lookOf(undefined), shape: shapeOf(undefined), size: sizeOf(undefined), feather: featherOf(undefined), blur: blurOf(undefined) };

/** The chrome over plain props (the stores are read by TopBar), so it renders anywhere, tests included. */
export function TopBarView({
  feeds,
  mode,
  onTheme,
  look = DEFAULT_LOOK_STATE,
  seen = 0,
  onSeen = () => {},
}: ChromeProps & { feeds: FeedState[]; mode: ThemeModeId; onTheme: (mode: ThemeModeId) => void; look?: LookState; seen?: number; onSeen?: (ms: number) => void }) {
  return (
    <Bar data-testid="hud-topbar">
      <LiveData list={feeds} seen={seen} onSeen={onSeen} />
      <Theme mode={mode} onPick={onTheme} />
      <Look {...look} />
      <Developer />
    </Bar>
  );
}
