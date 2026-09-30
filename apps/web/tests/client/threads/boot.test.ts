import { describe, expect, test } from "bun:test";

import { chooseTransport, detectTransport } from "client/threads/boot";

describe("transport selection", () => {
  test("SAB rings need isolation and the constructor", () => {
    expect(chooseTransport({ crossOriginIsolated: true, sharedArrayBuffer: true })).toBe("sab");
    expect(chooseTransport({ crossOriginIsolated: false, sharedArrayBuffer: true })).toBe("message");
    expect(chooseTransport({ crossOriginIsolated: true, sharedArrayBuffer: false })).toBe("message");
    expect(chooseTransport({ crossOriginIsolated: false, sharedArrayBuffer: false })).toBe("message");
  });

  test("the test hook forces postMessage", () => {
    expect(chooseTransport({ crossOriginIsolated: true, sharedArrayBuffer: true, forceMessage: true })).toBe("message");
  });

  test("detectTransport reads the live globals (bun has SAB, no crossOriginIsolated gate)", () => {
    const g = globalThis as { crossOriginIsolated?: boolean };
    const before = g.crossOriginIsolated;
    try {
      g.crossOriginIsolated = true;
      expect(detectTransport()).toBe("sab");
      g.crossOriginIsolated = false;
      expect(detectTransport()).toBe("message");
      delete g.crossOriginIsolated;
      expect(detectTransport()).toBe("message");
    } finally {
      if (before === undefined) delete g.crossOriginIsolated;
      else g.crossOriginIsolated = before;
    }
  });
});
