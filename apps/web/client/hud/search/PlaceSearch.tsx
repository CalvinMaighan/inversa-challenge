"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { browserPlacesDeps } from "client/places/browser";
import { flyToHit } from "client/places/fly";
import { createPlaceSearch, LIMITED_MESSAGE, MIN_REMOTE_CHARS, type SearchResult } from "client/places/search";
import styled from "client/styled";
import type { PlaceHit } from "shared/places";

import { MOBILE } from "../primitives";
import { usePopover } from "../topbar/TopBar";
import Credit from "./Credit";

const Wrap = styled.div`
  position: relative;
`;

/** The bottom bar's glass pill: icon and a plain word, so a novice knows what it does. */
const Trigger = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in oklch, var(--surface) 82%, transparent);
  backdrop-filter: blur(10px) saturate(1.2);
  -webkit-backdrop-filter: blur(10px) saturate(1.2);
  box-shadow: var(--shadow);
  color: var(--text);
  font: 600 12px / 1 var(--font-ui);
  cursor: pointer;

  &:hover,
  &[aria-expanded="true"] {
    border-color: var(--accent);
  }

  svg {
    width: 14px;
    height: 14px;
  }
`;

const Pop = styled.div`
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 9;
  width: min(380px, calc(100vw - 2 * var(--gap-m)));
  max-height: min(60vh, 460px);
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

  label {
    display: block;
    margin-bottom: 4px;
    color: var(--muted);
    font: 600 12px / 1.4 var(--font-ui);
  }

  input {
    width: 100%;
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--bg, transparent);
    color: var(--text);
    font: 400 14px / 1 var(--font-ui);
  }

  ${MOBILE} {
    width: calc(100vw - 2 * var(--gap-s));
  }
`;

const Options = styled.ul`
  margin: var(--gap-s) 0 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-s);
    cursor: pointer;
  }

  li[aria-selected="true"] {
    border-color: var(--accent);
    background: color-mix(in oklch, var(--accent) 16%, transparent);
  }

  li:hover {
    border-color: var(--hud-line, var(--border));
  }

  .name {
    font-weight: 600;
  }

  .addr {
    color: var(--muted);
    font-size: 12px;
  }
`;

const Status = styled.p`
  margin: var(--gap-s) 0 0;
  color: var(--muted);
  font-size: 12px;

  /* Kept in the tree while empty: a live region that appears late is not always announced. */
  &:empty {
    margin: 0;
  }
`;

const Notice = styled.p`
  margin: var(--gap-s) 0 0;
  color: var(--text);
  font-size: 12px;
`;

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </svg>
  );
}

function statusLine(query: string, busy: boolean, result: SearchResult | null): string {
  if (busy) return "Searching…";
  if (!result || result.query !== query) return query.trim().length > 0 && query.trim().length < MIN_REMOTE_CHARS ? "Keep typing…" : "";
  const n = result.hits.length;
  const found = n === 0 ? "No places found." : `${n} place${n === 1 ? "" : "s"}. Arrow keys to choose, Enter to fly there.`;
  return result.error ? `${result.error} ${found}` : found;
}

/**
 * Search (docs/places.md, gates/leaf-GE6.md): a bottom-bar button that opens a search box upwards. The box is an
 * ARIA combobox: typing lists places (local field names, then Google Places or, without a key, OpenStreetMap),
 * the arrow keys move through them, Enter flies the globe there, Esc closes and hands focus back to the button.
 * Nothing is drawn on the map.
 */
export default function PlaceSearch() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pop = usePopover(triggerRef, popRef);
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const searcher = useMemo(() => (typeof window === "undefined" ? null : createPlaceSearch(browserPlacesDeps())), []);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const [noKey, setNoKey] = useState(false);

  // Focus goes to the box, not the popover (this runs after usePopover's own focus).
  useEffect(() => {
    if (!pop.open) {
      searcher?.cancel();
      return;
    }
    inputRef.current?.focus({ preventScroll: true });
  }, [pop.open, searcher]);

  useEffect(() => () => searcher?.cancel(), [searcher]);

  const hits: PlaceHit[] = result && result.query === query ? result.hits : [];
  const listed = hits.length > 0;

  const onInput = (value: string) => {
    setQuery(value);
    setActive(-1);
    if (!searcher) return;
    if (!value.trim()) {
      searcher.cancel();
      setBusy(false);
      setResult(null);
      return;
    }
    setBusy(true);
    void searcher.search(value).then((r) => {
      if (!r) return;
      setResult(r);
      setBusy(false);
    });
  };

  const choose = (hit: PlaceHit) => {
    flyToHit(hit);
    setQuery("");
    setResult(null);
    pop.close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && listed) {
      e.preventDefault();
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === "ArrowUp" && listed) {
      e.preventDefault();
      setActive((a) => (a <= 0 ? hits.length - 1 : a - 1));
    } else if (e.key === "Enter" && listed) {
      e.preventDefault();
      choose(hits[active >= 0 ? active : 0]!);
    }
  };

  const notice = result?.notice ?? (noKey ? LIMITED_MESSAGE : null);

  return (
    <Wrap>
      <Trigger
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        data-testid="search-button"
        onClick={() => {
          // Read when opening: the Developer panel may have added or removed the key since.
          setNoKey(!browserPlacesDeps().key()?.trim());
          pop.toggle();
        }}
      >
        <SearchIcon />
        Search
      </Trigger>
      {pop.open ? (
        <Pop
          ref={popRef}
          id={id}
          role="dialog"
          aria-label="Search places"
          tabIndex={-1}
          data-testid="search-popover"
          data-hud-obstacle=""
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              pop.close();
            }
          }}
        >
          <label htmlFor={`${id}-input`}>Find a place and fly there</label>
          <input
            ref={inputRef}
            id={`${id}-input`}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listed}
            aria-controls={listed ? listId : undefined}
            aria-activedescendant={listed && active >= 0 ? optionId(active) : undefined}
            placeholder="A town, park, bay or reef"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={onKeyDown}
            data-testid="search-input"
          />
          {listed ? (
            <Options id={listId} role="listbox" aria-label="Places found" data-testid="search-results">
              {hits.map((h, i) => (
                <li
                  key={h.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  data-source={h.source}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(h)}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="name">{h.name}</span>
                  {h.address ? <span className="addr">{h.address}</span> : null}
                </li>
              ))}
            </Options>
          ) : null}
          <Status role="status" data-testid="search-status">
            {statusLine(query, busy, result)}
          </Status>
          {notice ? <Notice data-testid="search-notice">{notice}</Notice> : null}
          {listed ? <Credit provider={result?.provider ?? null} /> : null}
        </Pop>
      ) : null}
    </Wrap>
  );
}
