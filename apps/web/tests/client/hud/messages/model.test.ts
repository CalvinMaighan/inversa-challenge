import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { init } from "@calvinjs/active-state";

import { DmLog } from "client/hud/messages/MessagesPanel";
import { callsignFor, DM_PRESENCE_TTL_MS, MAX_DM_CHARS, presenceOf, teamMessages, threadMessages, threadRows } from "client/hud/messages/model";
import { directMessageOp } from "client/hud/missions/board";
import { state } from "client/state";
import { PEER_TTL_MS, type Peer } from "client/state/peers";
import { Clock } from "client/threads/crdt/hlc";
import { applyOps, createState, viewBoard, type MessageView } from "client/threads/crdt/merge";
import { admitInbound, RateLimit } from "client/threads/rtc/stream";

init(state);

const now = Date.parse("2026-10-01T12:00:00Z");
const peer = (id: string, agoMs = 0, link: Peer["link"] = "open"): Peer => ({ peerId: id, callsign: `Ranger-${id.toUpperCase()}`, color: "#4fb3ff", seenAt: new Date(now - agoMs).toISOString(), cursor: null, link });
const msg = (id: string, nodeId: string, body: string, thread: string | null, to: string | null, hlc = `1700000000${id}:0:${nodeId}`): MessageView => ({ id, body, hlc, nodeId, to, thread });

describe("messages model", () => {
  test("threadMessages and teamMessages split the board's messages by thread", () => {
    const all = [msg("001", "a", "team", null, null), msg("002", "a", "to b", "dm:a~b", "b"), msg("003", "c", "to a", "dm:a~c", "a")];
    expect(threadMessages(all, "dm:a~b").map((m) => m.id)).toEqual(["002"]);
    expect(teamMessages(all).map((m) => m.id)).toEqual(["001"]);
    expect(MAX_DM_CHARS).toBe(2_000);
  });

  test("presence: online within the TTL on an open data channel; stale, closed, relayed (no channel for keystrokes) or unknown peers are away", () => {
    const peers = [peer("b", DM_PRESENCE_TTL_MS), peer("c", PEER_TTL_MS + 1), peer("d", 0, "closed"), peer("e", 10, "relay"), peer("f", 10, "connecting"), peer("g", DM_PRESENCE_TTL_MS + 1)];
    expect(presenceOf("b", peers, now)).toBe("online");
    expect(presenceOf("c", peers, now)).toBe("away");
    expect(presenceOf("d", peers, now)).toBe("away");
    expect(presenceOf("e", peers, now)).toBe("away");
    expect(presenceOf("f", peers, now)).toBe("away");
    expect(presenceOf("g", peers, now)).toBe("away"); // open channel, but no heartbeat for over 20 s: the tab is gone
    expect(presenceOf("zz", peers, now)).toBe("away");
    expect(callsignFor("b", peers)).toBe("Ranger-B");
    expect(callsignFor("0123456789", peers)).toBe("01234567");
  });

  test("threadRows lists live peers and past threads, online first, with the last message", () => {
    const peers = [peer("b"), peer("c", PEER_TTL_MS + 1)];
    const all = [msg("001", "c", "old thread", "dm:a~c", "a"), msg("002", "a", "to b", "dm:a~b", "b"), msg("003", "z", "someone else's", "dm:y~z", "y"), msg("004", "a", "team", null, null)];
    const rows = threadRows(all, peers, "a", now);
    expect(rows.map((r) => [r.peerId, r.presence, r.count, r.last?.body ?? null])).toEqual([
      ["b", "online", 1, "to b"],
      ["c", "away", 1, "old thread"],
    ]);
  });
});

describe("dm injection", () => {
  const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>[link](javascript:alert(1)) **bold**`;

  const nameOf = (id: string) => `Ranger-${id.toUpperCase()}`;
  const colorOf = () => "#4fb3ff";

  test("dm injection: a message with <img onerror> and markdown renders as escaped text, never as elements", () => {
    const html = renderToStaticMarkup(createElement(DmLog, { messages: [msg("001", "b", payload, "dm:a~b", "a")], draft: null, nameOf, colorOf }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<strong");
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).toContain("**bold**");
    expect(html).toContain('data-testid="dm-message"');
  });

  test("dm injection: a live draft with the payload renders as text, the caret an empty span at the author's position", () => {
    const html = renderToStaticMarkup(createElement(DmLog, { messages: [], draft: { msgId: "m", from: "b", text: payload, caret: 4, at: now }, nameOf, colorOf }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    // Emotion puts a <style> before the caret span; the text around it is still split exactly at caret 4.
    expect(html).toMatch(/&lt;img(<style[^>]*>[^<]*<\/style>)?<span[^>]*data-testid="dm-caret"[^>]*><\/span> src=x/);
    expect(html).toContain('data-testid="dm-live"');
  });

  test("dm injection: the text survives the CRDT untouched as a string, with to and thread", () => {
    const f = { clock: new Clock("b"), boardId: "everglades", nodeId: "b", now: () => 1_700_000_000_000 };
    const op = directMessageOp(f, "m1", { body: payload, to: "a", thread: "dm:a~b" });
    const view = viewBoard(applyOps(createState("everglades"), [op]));
    expect(view.messages).toEqual([{ id: "m1", body: payload, hlc: op.hlc, nodeId: "b", to: "a", thread: "dm:a~b" }]);
  });

  test("dm injection: a peer cannot spoof `from`: the channel's peer id replaces whatever it claimed", () => {
    const bucket = new RateLimit();
    const forged = admitInbound({ type: "dm.typing", thread: "dm:a~b", from: "a", on: true }, "mallory", "b", bucket, 0);
    expect(forged?.from).toBe("mallory");
    const delta = admitInbound({ type: "dm.delta", thread: "dm:a~b", msgId: "m", from: "a", to: "b", seq: 1, at: 0, del: { pos: 0, len: 0 }, ins: "x" }, "mallory", "b", bucket, 0);
    expect(delta?.from).toBe("mallory");
    // And a message addressed to somebody else never reaches this node.
    expect(admitInbound({ type: "dm.delta", thread: "dm:a~b", msgId: "m", from: "a", to: "c", seq: 1, at: 0, del: { pos: 0, len: 0 }, ins: "x" }, "a", "b", bucket, 0)).toBeNull();
  });

  test("dm injection: no messages view uses innerHTML or dangerouslySetInnerHTML", () => {
    const dir = join(import.meta.dir, "../../../../client/hud/messages");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const f of sources) expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML/);
  });
});
