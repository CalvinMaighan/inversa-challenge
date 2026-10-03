import { describe, expect, test } from "bun:test";

import { buildAgentRegistry, CAPABILITY_NAMES } from "@/server/agent/tools/capabilities";
import { controlTools } from "@/server/agent/tools/map";
import { buildVoiceInstructions, HANDOFF_TOOLS, voiceToolsFor } from "@/server/voice/voice-prompt";
import { APP_IDS, getApp } from "@/shared/apps";
import { UI_TOOL_NAMES } from "@/shared/voice/ui-tools";

/**
 * The hands-free agent does everything the typed one does: the typed agent's map controls are the voice's UI tools of the
 * same name (it acts on them at once), and every other tool of the typed agent (data, conditions, species facts, notes) is
 * reached through `spawn_thinking`, which runs the same agent with the same registry and the same view. A tool added to one
 * side without the other fails here.
 */

/** Typed-agent controls the voice reaches differently: set_view (camera presets and a past moment) is fly_to, select_area and set_time. */
const TYPED_ONLY_CONTROLS = ["set_view"];

describe("hands-free agent parity", () => {
  test("every map control of the typed agent is a UI tool of the voice, for every app", () => {
    for (const id of APP_IDS) {
      const app = getApp(id);
      const typed = [...controlTools(app).map((t) => t.name), "toggle_layer", "set_look"];
      for (const name of typed) expect([id, name, (UI_TOOL_NAMES as string[]).includes(name)]).toEqual([id, name, true]);
    }
  });

  test("the voice is offered every UI tool and the hand-off to the analyst, and its persona names each one", () => {
    for (const id of APP_IDS) {
      const app = getApp(id);
      const offered = voiceToolsFor(app).map((t) => t.name);
      for (const name of [...UI_TOOL_NAMES, ...HANDOFF_TOOLS.map((t) => t.name)]) expect(offered).toContain(name);
      const persona = buildVoiceInstructions(app);
      for (const name of UI_TOOL_NAMES) expect([id, name, persona.includes(name)]).toEqual([id, name, true]);
    }
  });

  test("the analyst the voice hands questions to has the typed agent's whole tool list, species_info included", () => {
    for (const id of APP_IDS) {
      const app = getApp(id);
      const analyst = buildAgentRegistry(app).list().map((t) => t.name).sort();
      expect(analyst).toEqual([...app.agent.tools].sort());
      expect(analyst).toContain("species_info");
      expect(analyst).toContain("switch_app");
    }
    expect(CAPABILITY_NAMES).toContain("species_info");
  });

  test("the only control the voice lacks by name is the one it covers with other tools", () => {
    for (const id of APP_IDS) {
      const app = getApp(id);
      const typedControls = app.agent.tools.filter((n) => (UI_TOOL_NAMES as string[]).includes(n) || TYPED_ONLY_CONTROLS.includes(n) || ["toggle_layer", "set_look"].includes(n));
      const missing = typedControls.filter((n) => !(UI_TOOL_NAMES as string[]).includes(n));
      expect(missing.every((n) => TYPED_ONLY_CONTROLS.includes(n))).toBe(true);
    }
    for (const covering of ["fly_to", "select_area", "set_time"]) expect(UI_TOOL_NAMES as string[]).toContain(covering);
  });
});

describe("hands-free agent knows all three apps", () => {
  test("the persona names switch_app for the whole product and never limits the voice to one app", () => {
    for (const id of APP_IDS) {
      const persona = buildVoiceInstructions(getApp(id));
      expect(persona).toContain("three apps");
      expect(persona).toContain("never refuse another species");
    }
  });
});
