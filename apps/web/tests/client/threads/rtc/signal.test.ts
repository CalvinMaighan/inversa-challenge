import { describe, expect, test } from "bun:test";

import { createSignaling } from "client/threads/rtc/signal";

describe("signaling client paths", () => {
  test("an app room <app>:main goes to the Worker as written (it refuses %3A); other characters stay escaped", async () => {
    const urls: string[] = [];
    const fake = async (input: string, init?: RequestInit) => {
      urls.push(input);
      return init?.method === "POST" ? new Response(null, { status: 204 }) : Response.json([]);
    };
    const s = createSignaling("http://signal.test/", fake);
    await s.announce("carp:main", "alice", "Alice");
    await s.listPeers("python:main");
    await s.drain("lionfish:main", "bob");
    await s.listPeers("a/b");
    expect(urls).toEqual([
      "http://signal.test/rooms/carp:main/peers",
      "http://signal.test/rooms/python:main/peers",
      "http://signal.test/rooms/lionfish:main/inbox/bob",
      "http://signal.test/rooms/a%2Fb/peers",
    ]);
  });
});
