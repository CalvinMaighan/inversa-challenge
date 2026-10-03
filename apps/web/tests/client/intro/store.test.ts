import { beforeEach, describe, expect, test } from "bun:test";
import { get, init } from "@calvinjs/active-state";

import { choose, enter, introInit, introState, resetIntro } from "client/intro/store";
import { ENTRY_ALTITUDE_M } from "client/intro/model";
import { state } from "client/state";
import { APP, type AppState } from "client/state/app";
import { TIME, type TimeState } from "client/state/time";
import { VIEW, type ViewState } from "client/state/view";
import { APP_IDS, getApp } from "shared/apps";

init(state);

const [CARP_ID, LIONFISH_ID] = APP_IDS;

beforeEach(() => resetIntro());

describe("first-run gate steps", () => {
  test("without a browser page the gate opens straight to the app", () => {
    introInit();
    expect(introState().phase).toBe("done");
  });

  test("the first click switches to the species and moves to the second step", () => {
    choose(LIONFISH_ID);
    expect(introState()).toMatchObject({ phase: "enter", app: LIONFISH_ID, busy: false });
    expect(get<AppState>(APP)?.id).toBe(LIONFISH_ID);
    // The camera stays high behind the gate, not on the app's own area.
    expect(get<ViewState>(VIEW)!.altitudeM).toBeGreaterThan(getApp(LIONFISH_ID).regions[0]!.camera.heightM);
  });

  test("another species can be chosen before entering", () => {
    choose(LIONFISH_ID);
    choose(CARP_ID);
    expect(introState().app).toBe(CARP_ID);
    expect(get<AppState>(APP)?.id).toBe(CARP_ID);
  });

  test("the second click without voice opens the app and flies to 5,000 km over the species", async () => {
    choose(LIONFISH_ID);
    const before = get<ViewState>(VIEW)!.seq;
    await enter(false);
    expect(introState().phase).toBe("leaving");
    const view = get<ViewState>(VIEW)!;
    expect(view.altitudeM).toBe(ENTRY_ALTITUDE_M);
    expect(view.seq).toBe(before + 1);
  });

  test("the gate keeps the whole globe in view and the timeline idle at its first day, whichever species is chosen", () => {
    for (const id of [LIONFISH_ID, CARP_ID, LIONFISH_ID]) {
      choose(id);
      const view = get<ViewState>(VIEW)!;
      expect(view.altitudeM).toBeGreaterThanOrEqual(10_000_000);
      const time = get<TimeState>(TIME)!;
      expect(time.at).toBe(time.from);
      expect(time.playing).toBe(false);
    }
  });

  test("entering presses play at 8x from the start of the timeline", async () => {
    choose(LIONFISH_ID);
    await enter(false);
    const time = get<TimeState>(TIME)!;
    expect(time).toMatchObject({ playing: true, speed: 8 });
    expect(time.at).toBe(time.from);
  });

  test("entering before a species is chosen does nothing", async () => {
    await enter(false);
    expect(introState().phase).toBe("pick");
  });
});
