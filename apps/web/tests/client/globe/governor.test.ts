import { describe, expect, test } from "bun:test";

import { createRenderGovernor } from "client/globe/governor";

function scene() {
  return { requestRenderMode: false, maximumRenderTimeChange: 0, renders: 0, requestRender() {
    this.renders += 1;
  } };
}

describe("render governor", () => {
  test("installs idle mode: requestRenderMode on, simulation time never triggers a render", () => {
    const s = scene();
    createRenderGovernor(s);
    expect(s.requestRenderMode).toBe(true);
    expect(s.maximumRenderTimeChange).toBe(Infinity);
  });

  test("holds are ref-counted by owner: continuous while any is held, idle plus one settling frame after", () => {
    const s = scene();
    const g = createRenderGovernor(s);
    g.hold("flight");
    g.hold("playback");
    g.hold("flight");
    expect(s.requestRenderMode).toBe(false);
    expect(g.diagnostics()).toEqual({ mode: "continuous", holds: ["flight", "playback"], requests: 0 });
    g.release("flight");
    expect(s.requestRenderMode).toBe(false);
    g.release("flight"); // double release is harmless
    const before = s.renders;
    g.release("playback");
    expect(s.requestRenderMode).toBe(true);
    expect(s.renders).toBe(before + 1);
    expect(g.diagnostics().mode).toBe("idle");
  });

  test("request forwards one frame and counts; nothing after dispose", () => {
    const s = scene();
    const g = createRenderGovernor(s);
    g.request();
    g.request();
    expect(s.renders).toBe(2);
    expect(g.diagnostics().requests).toBe(2);
    g.dispose();
    g.request();
    g.hold("x");
    expect(s.renders).toBe(2);
    expect(s.requestRenderMode).toBe(true);
  });
});
