"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import styled from "client/styled";

import { Dot, Surface } from "../primitives";
import CategoryIcon from "../species/CategoryIcon";
import { PopoverBox, usePopover } from "../topbar/TopBar";
import { fetchAppHealth, type AppHealth } from "./health";
import { appIconCategory, appOptions, appTint, nextIndex } from "./model";
import { switchApp } from "./switch";
import { useActiveApp } from "./use-active-app";
import type { AppId } from "shared/apps";

/** Same round chrome button as About and Theme (TopBar), on the left of the HUD's top row. */
const Trigger = styled(Surface.withComponent("button"))`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  color: var(--text);
  cursor: pointer;

  &:hover,
  &[aria-expanded="true"] {
    border-color: var(--hud-line);
  }
`;

const Anchor = styled.div`
  position: relative;
  flex: none;
`;

const List = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Option = styled.button`
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 9px;
  align-items: center;
  column-gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-m);
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;

  &:hover {
    background: color-mix(in oklab, var(--accent) 8%, transparent);
  }

  &[aria-current="true"] {
    border-color: color-mix(in oklab, var(--accent) 55%, var(--border));
    background: color-mix(in oklab, var(--accent) 12%, transparent);
  }

  b {
    display: block;
    font: 600 13px / 1.3 var(--font-ui);
  }

  small {
    display: block;
    overflow: hidden;
    color: var(--muted);
    font: 400 12px / 1.35 var(--font-ui);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
`;

const Hidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`;

const TRIGGER = '[data-testid="app-select-button"]';

/**
 * The app selector (PLAN.md C-A5, docs/APPS.md): a round button with the active app's icon, top left of the HUD,
 * opening a popover that lists carp, lionfish and python with icon, name, one-line question and a feed-health dot
 * from `/health`. Choosing one switches the app in place (store, URL `?app=`, localStorage). Same popover as
 * About and Theme: Escape or a click outside closes it and Escape gives focus back to the button. Tab or the arrow
 * keys move through the apps; Enter or Space picks one, and focus lands on the (new) button.
 */
export default function AppSelect() {
  const app = useActiveApp();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pop = usePopover(triggerRef, popRef);
  const id = useId();
  const [health, setHealth] = useState<Record<AppId, AppHealth> | null>(null);
  const options = appOptions(app.id, health);

  useEffect(() => {
    if (!pop.open) return;
    // usePopover focused the popover; the current app is the better start.
    itemRefs.current[options.findIndex((o) => o.selected)]?.focus({ preventScroll: true });
    const controller = new AbortController();
    void fetchAppHealth(fetch, controller.signal).then((h) => {
      if (!controller.signal.aborted) setHealth(h);
    });
    return () => controller.abort();
    // Once per opening; `options` follows `app`, which cannot change while the popover is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop.open]);

  const choose = (next: AppId) => {
    if (next === app.id) {
      pop.close();
      return;
    }
    pop.close();
    switchApp(next);
    // The HUD remounts for the new app (AppScope), so the button that had focus is gone: give it to the new one.
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(TRIGGER)?.focus({ preventScroll: true }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextIndex(e.key, Math.max(0, current), items.length);
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };

  const label = `App: ${app.name}. Choose an app`;
  return (
    <Anchor>
      <Trigger
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        aria-label={label}
        title={label}
        data-testid="app-select-button"
        data-app={app.id}
        onClick={pop.toggle}
      >
        <CategoryIcon category={appIconCategory(app.icon)} color={appTint(app)} size={18} />
      </Trigger>
      {pop.open ? (
        <PopoverBox id={id} label="Choose an app" testId="app-select-popover" popRef={popRef} onClose={pop.close} align="left">
          <List aria-label="Apps" onKeyDown={onKeyDown}>
            {options.map((o, i) => (
              <li key={o.id}>
                <Option
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  aria-current={o.selected ? "true" : undefined}
                  title={o.question}
                  data-app-option={o.id}
                  data-health={o.health}
                  onClick={() => choose(o.id)}
                >
                  <CategoryIcon category={o.icon} color={o.tint} size={22} />
                  <span>
                    <b>{o.name}</b>
                    <small>{o.question}</small>
                  </span>
                  <Dot $tone={o.tone} title={o.healthLabel} aria-hidden="true" />
                  <Hidden>, {o.healthLabel}</Hidden>
                </Option>
              </li>
            ))}
          </List>
        </PopoverBox>
      ) : null}
    </Anchor>
  );
}
