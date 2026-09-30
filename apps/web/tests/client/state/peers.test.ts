import { describe, expect, test } from "bun:test";

import { livePeers, PEER_TTL_MS, PEERS, type Peer } from "client/state/peers";

const now = Date.parse("2026-09-30T20:00:00Z");
const peer = (callsign: string, agoMs: number, link: Peer["link"] = "open"): Peer => ({
  peerId: callsign.toLowerCase(),
  callsign,
  color: "#fff",
  seenAt: new Date(now - agoMs).toISOString(),
  cursor: null,
  link,
});

describe("PEERS", () => {
  test("starts as an empty list; TTL matches the signaling heartbeat", () => {
    expect(PEERS.defaults).toEqual([]);
    expect(PEER_TTL_MS).toBe(60_000);
  });

  test("livePeers drops stale and closed peers and sorts by callsign", () => {
    const peers = [peer("Zulu", 1_000), peer("Alpha", PEER_TTL_MS), peer("Stale", PEER_TTL_MS + 1), peer("Gone", 0, "closed"), peer("Relay", 5, "relay")];
    expect(livePeers(peers, now).map((p) => p.callsign)).toEqual(["Alpha", "Relay", "Zulu"]);
  });
});
