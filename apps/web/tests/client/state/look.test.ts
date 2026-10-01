import { describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import { get, set } from "@calvinjs/active-state";

import * as presets from "client/globe/look/presets";
import { LOOK_PRESETS, lookPreset } from "client/globe/look/presets";
import { decodeShareLink, encodeShareLink, type ShareState } from "client/hud/share-link";
import { applyShareState, readShareState } from "client/hud/share-link-store";
import { DEFAULT_LOOK, DEFAULT_SCOPE_FEATHER, DEFAULT_SCOPE_ON, featherOf, isLookId, LOOK, LOOK_IDS, lookOf, SCOPE_FEATHER, SCOPE_ON, scopeOnOf } from "client/state/look";

selectPython();

const resetLook = () => {
  set(LOOK, LOOK.defaults);
  set(SCOPE_ON, SCOPE_ON.defaults);
  set(SCOPE_FEATHER, SCOPE_FEATHER.defaults);
};

describe("look presets", () => {
  test("seven ids, in the order of the Look popover, normal first", () => {
    expect(LOOK_IDS).toEqual(["normal", "crt", "nvg", "flir", "noir", "anime", "snow"]);
    expect(LOOK_PRESETS.map((p) => p.id)).toEqual([...LOOK_IDS]);
    expect(new Set(LOOK_PRESETS.map((p) => p.label)).size).toBe(7);
  });

  test("defaults: normal, scope on, feather 11", () => {
    expect(LOOK.defaults).toBe("normal");
    expect(DEFAULT_LOOK).toBe("normal");
    expect(SCOPE_ON.defaults).toBe(true);
    expect(DEFAULT_SCOPE_ON).toBe(true);
    expect(SCOPE_FEATHER.defaults).toBe(11);
    expect(DEFAULT_SCOPE_FEATHER).toBe(11);
  });

  test("normal has no shader; every other preset mixes by intensity and reads the scene; no shader draws the scope", () => {
    expect(lookPreset("normal").fragmentShader).toBeNull();
    for (const p of LOOK_PRESETS) {
      if (p.id === "normal") continue;
      const glsl = p.fragmentShader!;
      expect(glsl).toContain("uniform sampler2D colorTexture;");
      expect(glsl).toContain("uniform float intensity;");
      expect(glsl).toContain("in vec2 v_textureCoordinates;");
      expect(glsl).toMatch(/out_FragColor = vec4\(mix\(src, .*intensity\), 1\.0\);/);
      // Original work: nothing lifted from the reference's shaders.
      expect(glsl).not.toContain("tubeMask");
      expect(glsl).not.toContain("renderTimestamp");
    }
    expect(LOOK_PRESETS.filter((p) => p.animated).map((p) => p.id)).toEqual(["crt", "nvg", "flir", "snow"]);
    // One scope: the stage shell's CSS circle (GE7 G1); the presets module has no scope shader any more.
    expect("SCOPE_SHADER" in presets).toBe(false);
    for (const p of LOOK_PRESETS) expect(p.fragmentShader ?? "").not.toContain("feather");
  });

  test("invalid values fall back to the defaults", () => {
    expect(isLookId("nvg")).toBe(true);
    expect(isLookId("thermal")).toBe(false);
    expect(lookOf("flir")).toBe("flir");
    expect(lookOf("retro")).toBe("normal");
    expect(lookOf(undefined)).toBe("normal");
    expect(lookOf(7)).toBe("normal");
    expect(featherOf(60)).toBe(60);
    expect(featherOf("42")).toBe(42);
    expect(featherOf(60.4)).toBe(60);
    expect(featherOf(-5)).toBe(0);
    expect(featherOf(250)).toBe(100);
    expect(featherOf(Number.NaN)).toBe(11);
    expect(featherOf("soft")).toBe(11);
    expect(featherOf(undefined)).toBe(11);
    expect(scopeOnOf(false)).toBe(false);
    expect(scopeOnOf("no")).toBe(true);
    expect(scopeOnOf(undefined)).toBe(true);
  });

  test("share-link round trip of look, scope and feather", () => {
    const state: ShareState = { app: "python", look: "nvg", scope: false, feather: 60 };
    const hash = encodeShareLink(state);
    expect(hash).toBe("v=2&app=python&look=nvg&scope=0&feather=60");
    expect(decodeShareLink(hash)).toEqual(state);
    expect(decodeShareLink(`#${hash}`)).toEqual(state);
    expect(encodeShareLink(decodeShareLink(hash))).toBe(hash);
    for (const look of LOOK_IDS) expect(decodeShareLink(encodeShareLink({ app: "python", look })).look).toBe(look === "normal" ? undefined : look);
    expect(decodeShareLink(encodeShareLink({ app: "python", feather: 0 })).feather).toBe(0);
    expect(decodeShareLink(encodeShareLink({ app: "python", feather: 100 })).feather).toBe(100);
  });

  test("share link omits the look at its defaults and drops invalid look fields", () => {
    expect(encodeShareLink({ app: "python", look: "normal", scope: true, feather: 11 })).toBe("v=2&app=python");
    expect(encodeShareLink({ app: "python", feather: 11.3 })).toBe("v=2&app=python");
    expect(encodeShareLink({ app: "python", feather: 999 })).toBe("v=2&app=python&feather=100");
    const bad = decodeShareLink("v=2&app=python&look=thermal&scope=yes&feather=abc&c=25,-80,1000,0,-90");
    expect(bad.look).toBeUndefined();
    expect(bad.scope).toBeUndefined();
    expect(bad.feather).toBeUndefined();
    expect(bad.camera).toBeDefined();
    expect(decodeShareLink("v=2&app=python&feather=101").feather).toBeUndefined();
    expect(decodeShareLink("v=2&app=python&feather=-1").feather).toBeUndefined();
    expect(decodeShareLink("v=2&app=python&feather=7").feather).toBe(7);
  });

  test("the store reads the look into the link and applies a link's look back", () => {
    resetLook();
    try {
      const atDefaults = readShareState();
      expect([atDefaults.look, atDefaults.scope, atDefaults.feather]).toEqual(["normal", true, 11]);
      expect(new URLSearchParams(encodeShareLink(atDefaults)).has("look")).toBe(false);

      applyShareState({ app: "python", look: "snow", scope: false, feather: 33 })();
      expect(get<string>(LOOK)).toBe("snow");
      expect(get<boolean>(SCOPE_ON)).toBe(false);
      expect(get<number>(SCOPE_FEATHER)).toBe(33);
      const hash = encodeShareLink(readShareState());
      expect(new URLSearchParams(hash).get("look")).toBe("snow");
      expect(new URLSearchParams(hash).get("scope")).toBe("0");
      expect(new URLSearchParams(hash).get("feather")).toBe("33");

      // A link without look fields leaves the look alone.
      applyShareState({ app: "python", feather: 5 })();
      expect(get<string>(LOOK)).toBe("snow");
      expect(get<number>(SCOPE_FEATHER)).toBe(5);
    } finally {
      resetLook();
    }
  });
});
