import { describe, expect, test } from "bun:test";
import { get, init } from "@calvinjs/active-state";

import { state } from "client/state";
import { APP, type AppState } from "client/state/app";
import { applyUiCommand } from "client/voice/ui-command-handler";

init(state);

describe("switch_app command", () => {
  test("moves the whole app to the species asked for, and a repeat is harmless", () => {
    expect(applyUiCommand({ name: "switch_app", args: { app: "carp" } })).toBe(true);
    expect(get<AppState>(APP)?.id).toBe("carp");
    expect(applyUiCommand({ name: "switch_app", args: { app: "carp" } })).toBe(true);
    expect(applyUiCommand({ name: "switch_app", args: { app: "lionfish" } })).toBe(true);
    expect(get<AppState>(APP)?.id).toBe("lionfish");
  });
});
