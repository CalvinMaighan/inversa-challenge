import { afterAll, describe, expect, test } from "bun:test";
import { selectPython } from "@/tests/client/python-app";
import { get, init, set } from "@calvinjs/active-state";

import { applyAgentSideEffects } from "client/agent/chat/effects";
import { state } from "client/state";
import { applyApp } from "client/state/app-switch";
import { LAYERS, type LayersState } from "client/state/layers";
import { LOOK } from "client/state/look";
import { VOICE, type VoiceState } from "client/state/voice";
import { applyUiCommand } from "client/voice/ui-command-handler";

init(state);
selectPython();
afterAll(() => {
  set(LOOK, LOOK.defaults);
  selectPython();
});

const visible = (id: string) => get<LayersState>(LAYERS)?.visible[id as keyof LayersState["visible"]];

describe("set_look schema", () => {
  test("set_look schema: the client applies set_look from the voice relay and from the agent's ui event", () => {
    expect(applyUiCommand({ name: "set_look", args: { look: "flir" } })).toBe(true);
    expect(get<string>(LOOK)).toBe("flir");
    expect(get<VoiceState>(VOICE)?.lastCommand).toBe("set_look");
    applyAgentSideEffects({ type: "ui", name: "set_look", args: { look: "nvg" } });
    expect(get<string>(LOOK)).toBe("nvg");
    // Not a look: ignored, the look stays.
    applyAgentSideEffects({ type: "ui", name: "set_look", args: { look: "sepia" } });
    expect(get<string>(LOOK)).toBe("nvg");
  });

  test("set_look schema: the agent's toggle_layer ui event switches the active app's layer, never another app's", () => {
    applyApp("carp");
    expect(visible("vessels")).toBe(false);
    applyAgentSideEffects({ type: "ui", name: "toggle_layer", args: { layer: "vessels", visible: true } });
    expect(visible("vessels")).toBe(true);
    selectPython();
    applyAgentSideEffects({ type: "ui", name: "toggle_layer", args: { layer: "vessels", visible: true } });
    expect(visible("vessels")).not.toBe(true);
  });
});
