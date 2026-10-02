import { describe, expect, test } from "bun:test";
import { get, init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import {
  APP,
  APP_STORAGE_KEY,
  type AppState,
  activeApp,
  activeAppId,
  appBootstrapScript,
  appFromHash,
  appFromSearch,
  readStoredApp,
  resolveActiveApp,
  storeApp,
  V1_APP,
} from "client/state/app";
import { DEFAULT_APP_ID } from "shared/apps";

init(state);
// Test files share one process: start from the default app whatever an earlier file left.
set(APP, APP.defaults);

/** A Storage stand-in; `fail` makes every call throw, as Safari private mode and blocked site data do. */
function storage(initial: Record<string, string> = {}, fail = false) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(k: string) {
      if (fail) throw new DOMException("denied", "SecurityError");
      return data.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (fail) throw new DOMException("quota", "QuotaExceededError");
      data.set(k, v);
    },
  };
}

describe("active app resolution", () => {
  test("active app: ?app= beats the default carp; the last app is not remembered across visits", () => {
    expect(DEFAULT_APP_ID).toBe("carp");
    expect(resolveActiveApp({ search: "?app=lionfish", storage: storage({ [APP_STORAGE_KEY]: "python" }) })).toBe("lionfish");
    // A stored app no longer decides: a new visit opens carp.
    expect(resolveActiveApp({ search: "", storage: storage({ [APP_STORAGE_KEY]: "python" }) })).toBe("carp");
    expect(resolveActiveApp({ search: "?x=1", storage: storage() })).toBe("carp");
    expect(resolveActiveApp({})).toBe("carp");
  });

  test("active app: invalid values fall through to the next source, then to carp", () => {
    expect(resolveActiveApp({ search: "?app=everglades", storage: storage({ [APP_STORAGE_KEY]: "python" }) })).toBe("carp");
    expect(resolveActiveApp({ search: "?app=", storage: storage({ [APP_STORAGE_KEY]: "Lionfish" }) })).toBe("carp");
    expect(resolveActiveApp({ search: "?app=PYTHON", storage: storage({ [APP_STORAGE_KEY]: "<script>" }) })).toBe("carp");
    expect(appFromSearch("?app=carp&app=python")).toBe("carp");
    expect(appFromSearch(null)).toBeNull();
  });

  test("active app: localStorage failures are swallowed (read and write)", () => {
    const broken = storage({}, true);
    expect(() => readStoredApp(broken)).not.toThrow();
    expect(readStoredApp(broken)).toBeNull();
    expect(resolveActiveApp({ search: "", storage: broken })).toBe("carp");
    expect(resolveActiveApp({ search: "?app=python", storage: broken })).toBe("python");
    expect(() => storeApp(broken, "lionfish")).not.toThrow();
    expect(readStoredApp(null)).toBeNull();
    const ok = storage();
    storeApp(ok, "lionfish");
    expect(ok.data.get(APP_STORAGE_KEY)).toBe("lionfish");
  });

  test("active app: a share link's app decides when the URL names none (an old v=1 link opens python)", () => {
    expect(appFromHash("#v=2&app=lionfish&c=17,-88,50000,0,-90")).toBe("lionfish");
    expect(appFromHash("#v=2&app=everglades&c=1,2,3,0,-90")).toBeNull();
    expect(appFromHash("#v=1&c=25.7,-80.2,45000,0,-90")).toBe(V1_APP);
    expect(V1_APP).toBe("python");
    expect(appFromHash("#c=25.7,-80.2,45000,0,-90")).toBe("python");
    expect(appFromHash("#v=1")).toBeNull();
    expect(appFromHash("#section-2")).toBeNull();
    expect(appFromHash("")).toBeNull();
    expect(resolveActiveApp({ search: "", hash: "#v=1&e=sighting:1", storage: storage({ [APP_STORAGE_KEY]: "lionfish" }) })).toBe("python");
    expect(resolveActiveApp({ search: "?app=carp", hash: "#v=2&app=lionfish&l=sightings", storage: storage() })).toBe("carp");
  });

  test("active app: the APP key holds the id; a bad value reads as the default", () => {
    expect(activeAppId()).toBe("carp");
    set(APP, { id: "lionfish" });
    expect(activeAppId()).toBe("lionfish");
    expect(activeApp().name).toBe("Lionfish Watch");
    set(APP, { id: "nope" as never });
    expect(activeAppId()).toBe("carp");
    set(APP, APP.defaults);
    expect(get<AppState>(APP)).toEqual({ id: "carp" });
  });
});

describe("active app head script", () => {
  /** Runs the inline script against a fake document, location and localStorage; returns the <html> attributes. */
  function run(search: string, hash: string, stored: string | null | "throw"): Record<string, string> {
    const attrs: Record<string, string> = {};
    const html = {
      setAttribute: (k: string, v: string) => void (attrs[k] = v),
      removeAttribute: (k: string) => void delete attrs[k],
    };
    const localStorage = {
      getItem: () => {
        if (stored === "throw") throw new Error("blocked");
        return stored;
      },
    };
    const fn = new Function("document", "location", "localStorage", "setTimeout", appBootstrapScript());
    fn({ documentElement: html }, { search, hash }, localStorage, () => 0);
    return attrs;
  }

  test("active app: the head script resolves like resolveActiveApp and hides the page only for a non-default app", () => {
    expect(run("?app=python", "", "lionfish")).toEqual({ "data-app": "python", "data-app-pending": "" });
    // A remembered app is ignored: a new visit opens carp.
    expect(run("", "", "lionfish")).toEqual({ "data-app": "carp" });
    expect(run("", "#v=1&c=25,-80,1000,0,-90", null)).toEqual({ "data-app": "python", "data-app-pending": "" });
    expect(run("", "", null)).toEqual({ "data-app": "carp" });
    expect(run("?app=carp", "", "python")).toEqual({ "data-app": "carp" });
    expect(run("?app=bogus", "", "throw")).toEqual({ "data-app": "carp" });
  });
});
