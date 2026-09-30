"use client";

import { useEffect, useRef, useState } from "react";
import { get } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import type { FeedState } from "shared/feed-state";

import { getGlobe } from "client/globe/api";
import { FEEDS } from "client/state/feeds";
import { THEME } from "client/state/theme";
import { TIME, type TimeState } from "client/state/time";
import { VIEW, type ViewState } from "client/state/view";
import styled from "client/styled";
import { THEME_MODES, type ThemeModeId } from "client/themes/palette";

import { Dot, Icon, IconButton, Mono, MOBILE, Pill, Surface, useIsMobile } from "../primitives";
import { formatClocks, isLive } from "./clock";
import { formatLatLon, unproject } from "./coords";
import { feedChip, feedSummary } from "./feed-chips";

const Bar = styled(Surface)`
  position: absolute;
  top: max(var(--gap-s), env(safe-area-inset-top));
  left: max(var(--gap-m), env(safe-area-inset-left));
  right: max(var(--gap-m), env(safe-area-inset-right));
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: var(--gap-m);
  padding: 5px var(--gap-s) 5px var(--gap-m);
  border-radius: var(--radius-m);
  z-index: 4;

  ${MOBILE} {
    left: var(--gap-s);
    right: var(--gap-s);
    flex-wrap: wrap;
    row-gap: 6px;
    gap: var(--gap-s);
  }
`;

const Brand = styled.div`
  display: flex;
  align-items: center;
  gap: var(--gap-s);
  font: 700 12px / 1 var(--font-mono);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  white-space: nowrap;
`;

/** The padding (taken back by the margin) leaves room for focus rings inside the scroll box, which clips. */
const Chips = styled.ul<{ $wrap?: boolean }>`
  display: flex;
  flex-wrap: ${(p) => (p.$wrap ? "wrap" : "nowrap")};
  gap: 6px;
  flex: 1;
  min-width: 0;
  margin: -4px;
  padding: 4px;
  list-style: none;
  overflow-x: ${(p) => (p.$wrap ? "visible" : "auto")};
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }

  ${MOBILE} {
    order: 10;
    flex-basis: 100%;
  }
`;

const FeedToggle = styled(Pill.withComponent("button"))`
  height: 26px;
  cursor: pointer;
`;

const ChipIcon = styled.span`
  display: inline-flex;
  color: var(--muted);
  svg {
    width: 11px;
    height: 11px;
    transition: transform 120ms ease;
  }
  &[data-open] svg {
    transform: rotate(90deg);
  }
`;

const Readouts = styled.div`
  display: flex;
  align-items: center;
  gap: var(--gap-m);
  margin-left: auto;
  font-size: 12px;
  white-space: nowrap;
`;

const Label = styled.span`
  color: var(--muted);
  font: 600 10px / 1 var(--font-mono);
  letter-spacing: 0.08em;
  margin-right: 4px;
`;

const HideOnPhone = styled.span`
  ${MOBILE} {
    display: none;
  }
`;

const Segmented = styled.div`
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  overflow: hidden;
  button {
    border: 0;
    border-radius: 0;
    height: 26px;
  }
  /* The group clips to its rounded border: draw the ring inside the button. */
  button:focus-visible {
    outline-offset: -2px;
  }
`;

function LiveBadge() {
  const mode = useActiveState<TimeState, "live" | "replay" | "playing">(TIME, (t) =>
    t.playing ? "playing" : isLive(t, Date.now()) ? "live" : "replay",
  )[0];
  const live = mode === "live";
  return (
    <Pill $tone={live ? "ok" : "warn"} data-testid="hud-live" aria-live="polite">
      <Dot $tone={live ? "ok" : "warn"} $pulse={live || mode === "playing"} />
      {live ? "LIVE" : mode === "playing" ? "REPLAY ▸" : "REPLAY"}
    </Pill>
  );
}

/**
 * Phones: one summary pill (worst state, how many feeds are off nominal) that expands the full chip list,
 * wrapped, instead of a row that scrolls sideways.
 */
function FeedChipsPhone({ list }: { list: FeedState[] }) {
  const [open, setOpen] = useState(false);
  const summary = feedSummary(list);
  return (
    <>
      <FeedToggle
        type="button"
        $tone={summary.tone}
        aria-expanded={open}
        aria-controls="hud-feed-chips"
        onClick={() => setOpen((v) => !v)}
        data-testid="hud-feeds-toggle"
      >
        <Dot $tone={summary.tone} $pulse={summary.state === "down"} />
        FEEDS {list.length - summary.degraded}/{list.length} OK
        <ChipIcon data-open={open ? "" : undefined}>
          <Icon name="chevron" />
        </ChipIcon>
      </FeedToggle>
      {open && <ChipList list={list} id="hud-feed-chips" wrap />}
    </>
  );
}

function ChipList({ list, id, wrap }: { list: FeedState[]; id?: string; wrap?: boolean }) {
  const summary = feedSummary(list);
  return (
    <Chips id={id} $wrap={wrap} aria-label={`Feeds: ${summary.degraded} of ${list.length} not nominal`}>
      {list.map((feed) => {
        const chip = feedChip(feed);
        return (
          <li key={chip.source}>
            <Pill $tone={chip.tone} title={chip.title} data-feed={chip.source} data-state={chip.state} tabIndex={0}>
              <Dot $tone={chip.tone} $pulse={chip.state === "down"} />
              {chip.label}
              <ChipIcon role="img" aria-label={chip.mode}>
                <Icon name={chip.mode} />
              </ChipIcon>
              <span style={{ opacity: 0.75 }}>{chip.lag}</span>
            </Pill>
          </li>
        );
      })}
    </Chips>
  );
}

function FeedChips() {
  const [feeds] = useActiveState<FeedState[]>(FEEDS);
  const phone = useIsMobile();
  const list = feeds ?? [];
  if (list.length === 0) {
    return (
      <Chips aria-label="Feeds">
        <li>
          <Pill $tone="muted" title="No feed state received yet">
            FEEDS —
          </Pill>
        </li>
      </Chips>
    );
  }
  return phone ? <FeedChipsPhone list={list} /> : <ChipList list={list} />;
}

function Clocks() {
  const replayAt = useActiveState<TimeState, string | null>(TIME, (t) => (isLive(t, Date.now()) && !t.playing ? null : (t.at ?? t.to)))[0];
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (replayAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [replayAt]);
  const c = formatClocks(replayAt ? Date.parse(replayAt) : now);
  return (
    <>
      <span data-testid="hud-clock-utc">
        <Label>{c.date}</Label>
        <Mono>{c.utc}</Mono>
      </span>
      <HideOnPhone>
        <Label>{c.zone}</Label>
        <Mono>{c.local}</Mono>
      </HideOnPhone>
    </>
  );
}

/**
 * Cursor lat/lon. Listens on the window (the globe receives the pointer, the HUD layer passes it through),
 * solves once per animation frame, and writes the text straight into the DOM: moving the mouse never
 * re-renders React.
 */
function CursorReadout() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    let x = 0;
    let y = 0;
    const solve = () => {
      frame = 0;
      const el = ref.current;
      const globe = getGlobe();
      if (!el) return;
      if (!globe) {
        el.textContent = "—";
        return;
      }
      const view = get<ViewState>(VIEW) ?? VIEW.defaults;
      const hit = unproject((lon, lat) => globe.project(lon, lat), x, y, { lon: view.lon, lat: view.lat });
      el.textContent = hit ? formatLatLon(hit) : "—";
    };
    const onMove = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(solve);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <HideOnPhone>
      <Label>CURSOR</Label>
      <Mono ref={ref} data-testid="hud-cursor">
        —
      </Mono>
    </HideOnPhone>
  );
}

function ThemeSwitch() {
  const [mode, setMode] = useActiveState<ThemeModeId>(THEME);
  return (
    <Segmented role="radiogroup" aria-label="Theme">
      {THEME_MODES.map((m) => (
        <IconButton key={m} type="button" role="radio" aria-checked={mode === m} $active={mode === m} onClick={() => setMode(m)} title={`${m} theme`}>
          {m === "tactical" ? "tac" : m}
        </IconButton>
      ))}
    </Segmented>
  );
}

export default function TopBar({ focus, onFocus }: { focus: boolean; onFocus: (next: boolean) => void }) {
  return (
    <Bar as="header" data-hud-obstacle="" data-testid="hud-topbar">
      <Brand>
        <HideOnPhone>Everglades Ops</HideOnPhone>
        <LiveBadge />
      </Brand>
      <FeedChips />
      <Readouts>
        <CursorReadout />
        <Clocks />
        <IconButton type="button" $active={focus} aria-pressed={focus} onClick={() => onFocus(!focus)} title="Focus: dim everything outside the selection">
          <Icon name="focus" />
          <HideOnPhone>Focus</HideOnPhone>
        </IconButton>
        <ThemeSwitch />
      </Readouts>
    </Bar>
  );
}
