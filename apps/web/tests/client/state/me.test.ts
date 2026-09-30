import { describe, expect, test } from "bun:test";
import { get, init, isPersisted, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { ensureIdentity, ME, PEER_COLORS, withIdentity, type MeState } from "client/state/me";

init(state);

const UUID = "0198f3a2-7c41-7e2b-9d10-5a6b7c8d9e0f";

describe("ME", () => {
  test("is persisted and starts without an identity", () => {
    expect(isPersisted("ME")).toBe(true);
    expect(ME.defaults.nodeId).toBe("");
  });

  test("withIdentity derives callsign and colour from the uuid", () => {
    const me = withIdentity(ME.defaults, UUID);
    expect(me.nodeId).toBe(UUID);
    expect(me.callsign).toBe("Ranger-0198");
    expect(me.color).toBe(PEER_COLORS[0x0f % PEER_COLORS.length]);
  });

  test("withIdentity keeps an existing identity and strips colons (HLC separator)", () => {
    const existing: MeState = { nodeId: "n1", callsign: "Heron", color: "#4fb3ff" };
    expect(withIdentity(existing, UUID)).toBe(existing);
    expect(withIdentity(ME.defaults, "a:b:c").nodeId).toBe("abc");
  });

  test("ensureIdentity assigns once, then returns the stored identity", () => {
    set(ME, ME.defaults);
    const first = ensureIdentity(() => UUID);
    expect(get<MeState>(ME)).toEqual(first);
    const second = ensureIdentity(() => "ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(second).toEqual(first);
    set(ME, ME.defaults);
  });
});
