import { describe, expect, test } from "bun:test";
import { get, init } from "@calvinjs/active-state";

import { applyAgentSideEffects, SWITCH_AFTER_ANSWER_MS } from "client/agent/chat/effects";
import { state } from "client/state";
import { APP, type AppState } from "client/state/app";
import { applyApp } from "client/state/app-switch";

init(state);
const app = () => get<AppState>(APP)?.id;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the agent switching apps", () => {
  test("the switch waits for the end of the answer, then moves the app", async () => {
    applyApp("lionfish");
    applyAgentSideEffects({ type: "ui", name: "switch_app", args: { app: "carp" } });
    expect(app()).toBe("lionfish");
    applyAgentSideEffects({ type: "done", content: "I switched to the carp app." });
    expect(app()).toBe("lionfish");
    await sleep(SWITCH_AFTER_ANSWER_MS + 150);
    expect(app()).toBe("carp");
  });

  test("a turn that ends with no answer (stopped, failed) does not switch", async () => {
    applyApp("lionfish");
    applyAgentSideEffects({ type: "ui", name: "switch_app", args: { app: "python" } });
    applyAgentSideEffects({ type: "done", content: "" });
    await sleep(SWITCH_AFTER_ANSWER_MS + 150);
    expect(app()).toBe("lionfish");
  });
});
