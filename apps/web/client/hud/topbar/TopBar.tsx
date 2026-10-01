"use client";

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useActiveState } from "@calvinjs/active-state/react";

import type { FeedState } from "shared/feed-state";

import { FEEDS } from "client/state/feeds";
import { THEME } from "client/state/theme";
import styled from "client/styled";
import { THEME_MODES, type ThemeModeId } from "client/themes/palette";

import LegendBody from "../legend/LegendPanel";
import { Dot, Icon, IconButton, MOBILE, Surface } from "../primitives";
import { ABOUT_SENTENCE } from "../help/content";
import { feedChip, feedSummary, sortFeedsForStatus } from "./feed-chips";
import { freshnessLines } from "./freshness";

/** The two icon buttons, pinned to the top right of the HUD's top row (which keeps room for them). */
const Bar = styled.header`
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  gap: 6px;
`;

const Round = styled(Surface.withComponent("button"))`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
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
  top: calc(100% + 6px);
  right: 0;
  z-index: 9;
  width: min(340px, calc(100cqw - 2 * var(--gap-m)));
  max-height: calc(100cqh - 140px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--gap-m);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow);
  color: var(--text);
  font: 400 13px / 1.45 var(--font-ui);
  scrollbar-width: thin;

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
    width: calc(100cqw - 2 * var(--gap-s));
  }
`;

const Fresh = styled.ul`
  margin: 0 0 var(--gap-s);
  padding: 0;
  list-style: none;
  color: var(--muted);
  font-size: 12.5px;
`;

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-s);
`;

const FeedList = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;

  li {
    display: grid;
    grid-template-columns: 9px 1fr auto auto;
    align-items: center;
    column-gap: 7px;
  }

  b {
    font: 600 12px / 1.3 var(--font-mono);
  }

  small {
    color: var(--muted);
    font: 400 11px / 1.3 var(--font-mono);
    white-space: nowrap;
  }

  p {
    grid-column: 2 / -1;
    margin: 0 0 3px;
    color: var(--muted);
    font-size: 11.5px;
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
function usePopover(triggerRef: RefObject<HTMLButtonElement | null>, popRef: RefObject<HTMLDivElement | null>) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    popRef.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && !popRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, popRef, triggerRef]);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  return { open, toggle: () => setOpen((v) => !v), close };
}

function PopoverBox({ id, label, testId, popRef, onClose, children }: { id: string; label: string; testId: string; popRef: RefObject<HTMLDivElement | null>; onClose: () => void; children: ReactNode }) {
  return (
    <Popover
      ref={popRef}
      id={id}
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

/** Technical feed health, worst first, each with its lag and, off nominal, the server's note. */
function Feeds({ list }: { list: FeedState[] }) {
  if (list.length === 0) return <p>No feed state received yet.</p>;
  return (
    <FeedList aria-label="Feeds">
      {sortFeedsForStatus(list).map((feed) => {
        const chip = feedChip(feed);
        return (
          <li key={chip.source} title={chip.title} data-feed={chip.source} data-state={chip.state}>
            <Dot $tone={chip.tone} />
            <b>{chip.label}</b>
            <small>
              {chip.state} · {chip.mode}
            </small>
            <small>{chip.lag}</small>
            {chip.state !== "nominal" && feed.note ? <p>{feed.note}</p> : null}
          </li>
        );
      })}
    </FeedList>
  );
}

function About({ list, focus, onFocus, helpOpen, onHelp }: ChromeProps & { list: FeedState[] }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pop = usePopover(triggerRef, popRef);
  const id = useId();
  const summary = feedSummary(list);
  const label =
    list.length === 0
      ? "About this map and its data"
      : `About this map and its data: ${summary.degraded === 0 ? "every data source running normally" : `${summary.degraded} of ${list.length} data sources delayed or down`}`;
  return (
    <>
      <Round
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        aria-label={label}
        title={label}
        data-testid="status-button"
        data-health={list.length === 0 ? "unknown" : summary.state}
        onClick={pop.toggle}
      >
        <Icon name="info" />
        {list.length > 0 && summary.degraded > 0 ? <Dot $tone={summary.tone} /> : null}
      </Round>
      {pop.open ? (
        <PopoverBox id={id} label="About this map" testId="status-popover" popRef={popRef} onClose={pop.close}>
          <AboutContent
            list={list}
            focus={focus}
            onFocus={onFocus}
            helpOpen={helpOpen}
            onHelp={() => {
              pop.close();
              onHelp(!helpOpen);
            }}
          />
        </PopoverBox>
      ) : null}
    </>
  );
}

/** What the About popover holds: what this is, freshness, Focus, Help, the data sources and the expert layers. */
export function AboutContent({
  list,
  nowMs,
  focus,
  onFocus,
  helpOpen,
  onHelp,
}: {
  list: FeedState[];
  /** Wall clock for "checked 6 min ago"; taken when the popover opens unless given (tests). */
  nowMs?: number;
  focus: boolean;
  onFocus: (next: boolean) => void;
  helpOpen: boolean;
  onHelp: () => void;
}) {
  const [expert, setExpert] = useState(false);
  const [now] = useState(() => nowMs ?? Date.now());
  return (
    <>
      <p>{ABOUT_SENTENCE}</p>
      <Fresh aria-label="Data freshness">
        {freshnessLines(list, now).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </Fresh>
      <Row>
        <IconButton type="button" $active={focus} aria-pressed={focus} onClick={() => onFocus(!focus)} title="Focus: dim everything outside the selection">
          <Icon name="focus" />
          Focus
        </IconButton>
        <IconButton type="button" $active={helpOpen} title="Help: what every control does" data-help-button="" data-testid="help-button" onClick={onHelp}>
          <Icon name="help" />
          Help
        </IconButton>
      </Row>
      <details data-testid="data-sources">
        <summary>Data sources</summary>
        <Feeds list={list} />
      </details>
      <details data-testid="expert-data" onToggle={(e) => setExpert(e.currentTarget.open)}>
        <summary data-testid="layers-button">More data (for experts)</summary>
        {expert ? <LegendBody active /> : null}
      </details>
    </>
  );
}

const THEME_LABELS: Record<ThemeModeId, string> = { light: "Light", dark: "Dark", tactical: "Tactical" };

function Theme({ mode, onPick }: { mode: ThemeModeId; onPick: (mode: ThemeModeId) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pop = usePopover(triggerRef, popRef);
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
 * The globe pane's chrome (T41): two icon buttons, top right, and no text until one opens. About (ⓘ, with a dot
 * in the colour of the worst feed when a source is delayed) holds what this is, how fresh the data is in plain
 * words, Focus, Help, the technical feed list under "Data sources" and the expert layers under "More data (for
 * experts)". Theme holds light, dark and tactical.
 */
export default function TopBar(props: ChromeProps) {
  const [feeds] = useActiveState<FeedState[]>(FEEDS);
  const [mode, setMode] = useActiveState<ThemeModeId>(THEME);
  return <TopBarView {...props} feeds={feeds ?? []} mode={mode ?? "dark"} onTheme={setMode} />;
}

type ChromeProps = { focus: boolean; onFocus: (next: boolean) => void; helpOpen: boolean; onHelp: (open: boolean) => void };

/** The chrome over plain props (the stores are read by TopBar), so it renders anywhere, tests included. */
export function TopBarView({ feeds, mode, onTheme, ...props }: ChromeProps & { feeds: FeedState[]; mode: ThemeModeId; onTheme: (mode: ThemeModeId) => void }) {
  return (
    <Bar data-testid="hud-topbar">
      <About list={feeds} {...props} />
      <Theme mode={mode} onPick={onTheme} />
    </Bar>
  );
}
