import { describe, expect, test } from "bun:test";
import { init, set } from "@calvinjs/active-state";

import { bootApp, switchApp, switchedUrl, type SwitchEnv } from "client/hud/appselect/switch";
import { APP, activeAppId, APP_STORAGE_KEY } from "client/state/app";
import { state } from "client/state";

init(state);

/** A browser stand-in: location, history and storage; `failing` storage throws on every call. */
function env(href: string, stored: string | null = null, failing = false) {
  const url = { href };
  const data = new Map<string, string>(stored ? [[APP_STORAGE_KEY, stored]] : []);
  const storage = {
    getItem: (k: string) => {
      if (failing) throw new Error("blocked");
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (failing) throw new Error("quota");
      data.set(k, v);
    },
  };
  const location = {
    get href() {
      return url.href;
    },
    get search() {
      return new URL(url.href).search;
    },
    get hash() {
      return new URL(url.href).hash;
    },
  };
  const history = { state: null, replaceState: (_s: unknown, _t: string, next: string | URL) => void (url.href = String(next)) };
  return { env: { location, history, storage } satisfies SwitchEnv & { location: typeof location }, data, url, storage };
}

describe("active app in the browser", () => {
  test("active app: switchApp writes the store, ?app= (dropping the old app's share hash) and localStorage", () => {
    set(APP, APP.defaults);
    const b = env("https://x.test/?app=carp&debug=1#v=2&app=carp&c=31,-91.5,9000,0,-90");
    expect(switchApp("lionfish", b.env)).toBe(true);
    expect(activeAppId()).toBe("lionfish");
    expect(b.url.href).toBe("https://x.test/?app=lionfish&debug=1");
    expect(b.data.get(APP_STORAGE_KEY)).toBe("lionfish");
    expect(switchedUrl("https://x.test/#v=1&c=1,2,3,0,-90", "python")).toBe("https://x.test/?app=python");
  });

  test("active app: a storage failure on switch is swallowed; the URL still carries the app", () => {
    const b = env("https://x.test/?app=lionfish", null, true);
    expect(() => switchApp("python", b.env)).not.toThrow();
    expect(activeAppId()).toBe("python");
    expect(b.url.href).toBe("https://x.test/?app=python");
  });

  test("active app: bootApp resolves ?app= > share link > carp (storage is not read), normalises the URL and keeps the hash", () => {
    let b = env("https://x.test/", "lionfish");
    expect(bootApp(b.env, b.storage)).toBe("carp");
    expect(b.url.href).toBe("https://x.test/?app=carp");

    b = env("https://x.test/?app=carp", "python");
    expect(bootApp(b.env, b.storage)).toBe("carp");
    expect(b.data.get(APP_STORAGE_KEY)).toBe("carp");

    b = env("https://x.test/#v=1&c=25,-80,1000,0,-90", "lionfish");
    expect(bootApp(b.env, b.storage)).toBe("python");
    expect(b.url.href).toBe("https://x.test/?app=python#v=1&c=25,-80,1000,0,-90");

    b = env("https://x.test/?app=nope", null, true);
    expect(bootApp(b.env, b.storage)).toBe("carp");
    expect(activeAppId()).toBe("carp");
  });
});
