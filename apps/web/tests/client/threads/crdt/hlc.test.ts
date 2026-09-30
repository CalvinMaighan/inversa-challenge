import { describe, expect, test } from "bun:test";

import { Clock, compare, format, HlcDriftError, MAX_DRIFT_MS, parse, receive, tick } from "client/threads/crdt/hlc";

describe("HLC", () => {
  test("parse and format round-trip, nodeId may contain colons", () => {
    const h = parse("1700000000000:7:node:with:colons");
    expect(h).toEqual({ wallMs: 1_700_000_000_000, counter: 7, nodeId: "node:with:colons" });
    expect(format(h!)).toBe("1700000000000:7:node:with:colons");
    expect(parse("+1:0:a")).toBeNull();
    expect(parse("1:0")).toBeNull();
    expect(parse("1:0:")).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse("1.5:0:a")).toBeNull();
  });

  test("compare: wallMs, then counter, then nodeId as strings", () => {
    expect(compare("100:0:a", "99:9:z")).toBeGreaterThan(0);
    expect(compare("100:1:a", "100:2:a")).toBeLessThan(0);
    expect(compare("100:1:b", "100:1:a")).toBeGreaterThan(0);
    expect(compare("100:1:node-9", "100:1:node-10")).toBeGreaterThan(0);
    expect(compare("1000:0:a", "999:0:a")).toBeGreaterThan(0);
    expect(compare("100:1:a", "100:1:a")).toBe(0);
    expect(() => compare("bad", "100:1:a")).toThrow();
  });

  test("tick is monotonic even when the wall clock stalls or goes backwards", () => {
    const c = new Clock("a");
    const a = c.tick(1000);
    const b = c.tick(1000);
    const d = c.tick(900);
    const e = c.tick(2000);
    expect([a, b, d, e].map(format)).toEqual(["1000:0:a", "1000:1:a", "1000:2:a", "2000:0:a"]);
    expect(compare(a, b)).toBeLessThan(0);
    expect(compare(b, d)).toBeLessThan(0);
    expect(compare(d, e)).toBeLessThan(0);
  });

  test("receive sorts the next local stamp after the remote one", () => {
    const c = new Clock("a");
    c.tick(1000);
    const r1 = c.receive("5000:3:b", 1000);
    expect(format(r1)).toBe("5000:4:a");
    expect(compare(r1, "5000:3:b")).toBeGreaterThan(0);
    const r2 = c.receive("5000:9:b", 1000);
    expect(format(r2)).toBe("5000:10:a");
    const r3 = c.receive("100:0:b", 1000);
    expect(format(r3)).toBe("5000:11:a");
    const r4 = c.receive("100:0:b", 9000);
    expect(format(r4)).toBe("9000:0:a");
    expect(c.current).toEqual(r4);
  });

  test("drift guard refuses clocks too far ahead", () => {
    const c = new Clock("a");
    expect(() => c.receive(`${1000 + MAX_DRIFT_MS + 1}:0:b`, 1000)).toThrow(HlcDriftError);
    expect(format(c.receive(`${1000 + MAX_DRIFT_MS}:0:b`, 1000))).toBe(`${1000 + MAX_DRIFT_MS}:1:a`);
    expect(() => c.tick(0)).toThrow(HlcDriftError);
    expect(() => new Clock("")).toThrow();
  });

  test("functional helpers return strings", () => {
    const c = new Clock("z", "10:0:z");
    expect(tick(c, 10)).toBe("10:1:z");
    expect(receive(c, "10:5:y", 10)).toBe("10:6:z");
  });
});
