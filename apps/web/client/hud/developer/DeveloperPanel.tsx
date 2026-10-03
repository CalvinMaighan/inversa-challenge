"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { set } from "@calvinjs/active-state";
import { useActiveState } from "@calvinjs/active-state/react";

import { FEEDS } from "client/state/feeds";
import type { FeedState } from "shared/feed-state";
import { browserKeyStore } from "client/keys";
import styled from "client/styled";
import type { BrowserKeyId, ServerKeyStatus } from "shared/keys";

import { Dot, GLASS_CSS, Icon, IconButton, POPOVER_BUTTONS_CSS } from "../primitives";
import { feedChip, sortFeedsForStatus } from "../topbar/feed-chips";
import { DEVELOPER_TAB, DEVELOPER_TABS, type DeveloperTab } from "./tab";
import { DEV_KEYS_URL, panelRows, removeBrowserKey, saveBrowserKeys, splitPasted, type PanelRow } from "./model";

const Dialog = styled.dialog`
  /* The HUD row lets the pointer through to the globe; the panel takes it back. */
  pointer-events: auto;
  width: min(640px, calc(100vw - 24px));
  /* A fixed height, so switching tabs never resizes the panel (each tab scrolls inside it). */
  height: min(86vh, 900px);
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  ${GLASS_CSS}
  color: var(--text);
  font: 400 13px / 1.45 var(--font-ui);
  ${POPOVER_BUTTONS_CSS}

  &[open] {
    display: flex;
    flex-direction: column;
  }

  &::backdrop {
    background: rgb(0 0 0 / 0.6);
  }
`;

const Head = styled.header`
  display: flex;
  flex: none;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 10px 10px 18px;
  border-bottom: 1px solid var(--border);

  > div {
    flex: 1;
  }

  small {
    display: block;
    color: var(--muted);
    font: 600 11px / 1.2 var(--font-mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h2 {
    margin: 4px 0 0;
    font: 600 19px / 1.25 var(--font-ui);
  }

  kbd {
    margin-top: 6px;
    color: var(--muted);
    font: 500 11px / 1.2 var(--font-mono);
    white-space: nowrap;
  }
`;

const TabList = styled.div`
  display: flex;
  flex: none;
  gap: 4px;
  padding: 8px 18px 0;
  border-bottom: 1px solid var(--border);

  button {
    margin-bottom: -1px;
    padding: 8px 14px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: var(--radius-s) var(--radius-s) 0 0;
    background: none;
    color: var(--muted);
    font: 600 12px / 1 var(--font-ui);
    cursor: pointer;
  }
  button:hover {
    color: var(--text);
  }
  button[aria-selected="true"] {
    border-color: var(--border);
    background: var(--surface);
    color: var(--text);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
`;

const Body = styled.form`
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;

  &[hidden] {
    display: none;
  }

  > p {
    margin: 0;
    padding: 10px 18px;
    color: var(--muted);
  }
`;

const Rows = styled.ul`
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0 18px;
  overflow-y: auto;
  overscroll-behavior: contain;
  list-style: none;
  scrollbar-width: thin;

  > li {
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
`;

const Line = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;

  b {
    font: 600 14px / 1.3 var(--font-ui);
  }

  a,
  button.text {
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    /* Text colour for contrast at 11 px; the accent marks it as a link. */
    color: var(--text);
    font: 600 11px / 1.2 var(--font-mono);
    letter-spacing: 0.08em;
    text-decoration: underline 1px var(--accent);
    text-underline-offset: 3px;
    cursor: pointer;
  }

  a:hover,
  button.text:hover {
    text-decoration-thickness: 2px;
  }
`;

const Badge = styled.span`
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  color: var(--muted);
  font: 600 10px / 1.2 var(--font-mono);
  letter-spacing: 0.06em;
`;

const Purpose = styled.p`
  margin: 4px 0 0 15px;
  color: var(--muted);
`;

const Field = styled.input`
  display: block;
  width: calc(100% - 15px);
  margin: 8px 0 0 15px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--bg);
  color: var(--text);
  font: 400 12.5px / 1.3 var(--font-mono);

  &::placeholder {
    color: var(--muted);
  }
`;

const Note = styled.p`
  margin: 6px 0 0 15px;
  color: var(--muted);
  font-size: 12px;

  code {
    padding: 1px 5px;
    border-radius: var(--radius-s);
    background: var(--surface-2, var(--bg));
    color: var(--text);
    font: 500 12px / 1.4 var(--font-mono);
    user-select: all;
  }

  input {
    width: 90px;
    margin: 0 6px;
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--bg);
    color: var(--text);
    font: 400 12px / 1.3 var(--font-mono);
  }
`;

const Foot = styled.footer`
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);

  p {
    flex: 1;
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  button[type="submit"] {
    padding: 8px 14px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-s);
    background: color-mix(in oklch, var(--accent) 22%, var(--surface));
    /* Accent-tinted with the theme's text colour: white on the accent read 4.24:1 and --bg 4.03:1 at 11 px (axe, GE7). */
    color: var(--text);
    font: 700 11px / 1 var(--font-mono);
    letter-spacing: 0.08em;
    cursor: pointer;
  }

  button[type="submit"]:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

/** Polls while a saved server key waits for the dev supervisor's restart (the web server is down meanwhile). */
const POLL_MS = 1_500;
const POLL_LIMIT_MS = 5 * 60_000;

async function fetchStatus(): Promise<ServerKeyStatus[] | null> {
  try {
    const res = await fetch(DEV_KEYS_URL, { cache: "no-store" });
    return res.ok ? ((await res.json()) as ServerKeyStatus[]) : null;
  } catch {
    return null;
  }
}

const FeedsBody = styled.div`
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;

  > p {
    margin: 0;
    padding: 10px 18px;
    color: var(--muted);
  }
`;

/** Tab 1: every data source the app reads, worst first, each with its mode, state and lag (the lionfish survey's feed list, for all apps). */
function FeedsPane() {
  const [feeds] = useActiveState<FeedState[]>(FEEDS);
  // A feed switched off by configuration (a push feed without its credentials) is not a source this app reads.
  const list = sortFeedsForStatus((feeds ?? []).filter((f) => !f.note?.startsWith("disabled:")));
  return (
    <FeedsBody role="tabpanel" id="developer-pane-feeds" aria-labelledby="developer-tab-feeds" data-testid="developer-feeds">
      <p>Every data source this app reads, worst first. Green: running normally. Yellow: lagging behind its usual schedule. Red: stale or down.</p>
      {list.length === 0 ? (
        <p>No feed state received yet.</p>
      ) : (
        <Rows tabIndex={0} aria-label="Feeds">
          {list.map((feed) => {
            const chip = feedChip(feed);
            return (
              <li key={chip.source} data-feed={chip.source} data-state={chip.state} title={chip.title}>
                <Line>
                  <Dot $tone={chip.tone} role="img" aria-label={chip.state} />
                  <b>{chip.label}</b>
                  <Badge>{chip.mode.toUpperCase()}</Badge>
                  <Badge>{chip.state.toUpperCase()}</Badge>
                  <span style={{ marginLeft: "auto", color: "var(--muted)", font: "500 11px / 1.2 var(--font-mono)" }}>lag {chip.lag}</span>
                </Line>
                {chip.state !== "nominal" && feed.note ? <Purpose>{feed.note}</Purpose> : null}
              </li>
            );
          })}
        </Rows>
      )}
    </FeedsBody>
  );
}

function Row({ row, onRemove }: { row: PanelRow; onRemove: (id: BrowserKeyId) => void }) {
  return (
    <li data-key-row={row.id} data-scope={row.scope} data-set={row.set ? "1" : "0"} data-pending={row.pending ? "1" : "0"}>
      <Line>
        <Dot $tone={row.set ? "ok" : row.pending ? "warn" : "muted"} $pulse={row.pending} role="img" aria-label={row.set ? "set" : row.pending ? "saved, loading" : "not set"} data-status="" />
        <b>{row.label}</b>
        {row.scope === "browser" ? <Badge title="Runs in the browser: restrict it at the provider">BROWSER-SIDE</Badge> : null}
        {row.removable ? (
          <button type="button" className="text" onClick={() => onRemove(row.id as BrowserKeyId)} aria-label={`Remove the ${row.label} key stored in this browser`}>
            REMOVE
          </button>
        ) : null}
      </Line>
      <Purpose>{row.purpose}</Purpose>
      {row.inputs.map((input) => (
        <Field
          key={input.name}
          type="password"
          name={input.name}
          placeholder={input.name}
          aria-label={input.label}
          autoComplete="off"
          spellCheck={false}
          data-key-input={row.scope}
        />
      ))}
      {row.pending ? <Note role="status">Saved. The API and web are restarting to load it…</Note> : null}
      {row.commands.length > 0 ? (
        <Note data-key-command="">
          Set on the server with{" "}
          {row.commands.map((c, i) => (
            <span key={c}>
              {i > 0 ? ", " : null}
              <code>{c}</code>
            </span>
          ))}
        </Note>
      ) : null}
    </li>
  );
}

/**
 * "Power up the globe" (docs/GODS_EYE.md, Developer panel spec): one row per provider in `KEY_REGISTRY`. Browser
 * keys are saved to localStorage and apply on the next globe load; server keys go to `POST /api/dev/keys` in local
 * development and otherwise show the Doppler command. A modal `<dialog>`: Esc or the close button closes it and
 * focus returns to the Developer button.
 */
export default function DeveloperPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [server, setServer] = useState<ServerKeyStatus[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const tab = useActiveState<DeveloperTab>(DEVELOPER_TAB)[0] ?? "feeds";
  const store = browserKeyStore();
  const rows = panelRows(store, server);
  const pending = rows.some((r) => r.pending);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // Each opening starts on the feeds.
    set(DEVELOPER_TAB, "feeds");
    return () => dialog?.close();
  }, []);

  // A failed fetch (the web server restarting) keeps the last status, so polling goes on until the key shows loaded.
  const refresh = useCallback(
    () =>
      fetchStatus().then((status) => {
        if (status) setServer(status);
      }),
    [],
  );
  useEffect(() => {
    let alive = true;
    void fetchStatus().then((status) => {
      if (alive) setServer(status);
    });
    return () => {
      alive = false;
    };
  }, []);

  // A saved server key: poll until the restarted server reports it loaded (or the limit passes).
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > POLL_LIMIT_MS) clearInterval(timer);
      else void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const values: Record<string, string> = {};
    for (const [name, value] of data.entries()) if (typeof value === "string") values[name] = value;
    const { browser, server: serverValues } = splitPasted(values);
    if (browser.length === 0 && Object.keys(serverValues).length === 0) {
      setMessage("Paste a key first.");
      return;
    }
    setBusy(true);
    const notes: string[] = [];
    if (browser.length > 0) {
      if (saveBrowserKeys(store, browser)) {
        notes.push("Browser keys saved in this browser; they apply on the next globe load.");
        setNeedsReload(true);
      } else notes.push("This browser refused to store the key (private mode or blocked storage).");
    }
    if (Object.keys(serverValues).length > 0) {
      try {
        const res = await fetch(DEV_KEYS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: serverValues }) });
        const body = (await res.json().catch(() => ({}))) as { saved?: string[]; external?: string[]; restart?: string; error?: string };
        if (res.status === 403) notes.push("This server does not take keys: set them in Doppler with the command shown.");
        else if (!res.ok) notes.push(body.error ?? `Saving failed (${res.status}).`);
        else {
          if (body.saved?.length) {
            notes.push(
              body.restart === "supervisor"
                ? "Server keys saved to data/local-keys.env; the API and web are restarting."
                : "Server keys saved to data/local-keys.env; restart bun run dev to load them.",
            );
          }
          if (body.external?.length) notes.push(`${body.external.join(", ")} already set outside this panel, kept as is.`);
        }
      } catch {
        notes.push("Saving failed: the server did not answer.");
      }
    }
    form.reset();
    setMessage(notes.join(" "));
    setBusy(false);
    setRevision((n) => n + 1);
    await refresh();
  };

  return (
    <Dialog
      ref={ref}
      aria-labelledby="developer-title"
      data-testid="developer-panel"
      data-hud-obstacle=""
      // No onClose: the effect's own close() (unmount, or StrictMode's re-run) must not close the panel again.
      onCancel={(e) => {
        // Esc: close through React so focus goes back to the button.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <Head>
        <div>
          <small>Provider settings</small>
          <h2 id="developer-title">Power up the globe</h2>
        </div>
        <kbd>Esc to close</kbd>
        <IconButton type="button" aria-label="Close provider settings" data-testid="developer-close" onClick={onClose}>
          <Icon name="close" />
        </IconButton>
      </Head>
      <TabList role="tablist" aria-label="Provider settings">
        {DEVELOPER_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`developer-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`developer-pane-${t.id}`} data-tab={t.id} onClick={() => set(DEVELOPER_TAB, t.id)}>
            {t.label}
          </button>
        ))}
      </TabList>
      {tab === "feeds" ? <FeedsPane /> : null}
      <Body ref={formRef} onSubmit={save} key={revision} autoComplete="off" hidden={tab !== "keys"} role="tabpanel" id="developer-pane-keys" aria-labelledby="developer-tab-keys">
        <p>The globe works without any keys. Each key below switches on another real feed. Green: the key is set. Grey: not set.</p>
        <Rows tabIndex={0} aria-label="Providers">
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              onRemove={(id) => {
                removeBrowserKey(store, id);
                setNeedsReload(true);
                setMessage("Removed from this browser; the globe drops it on the next load.");
                setRevision((n) => n + 1);
              }}
            />
          ))}
        </Rows>
        <Foot>
          <p role="status" data-testid="developer-message">
            {message}
            {needsReload ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  style={{ border: 0, background: "none", color: "var(--text)", textDecoration: "underline 1px var(--accent)", textUnderlineOffset: 3, cursor: "pointer", padding: 0, font: "inherit" }}
                >
                  Reload now
                </button>
              </>
            ) : null}
          </p>
          <button type="submit" disabled={busy} data-testid="developer-save">
            SAVE KEYS
          </button>
        </Foot>
      </Body>
    </Dialog>
  );
}
