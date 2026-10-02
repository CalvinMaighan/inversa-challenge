import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { init, set } from "@calvinjs/active-state";

import { state } from "client/state";
import { APP } from "client/state/app";
import { gqlRequest } from "client/threads/api";
import { APP_IDS } from "shared/apps";

init(state);

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  set(APP, APP.defaults);
});

describe("app prefix", () => {
  test("app prefix: gqlRequest outside a browser posts to the active app's /v1/<app>/graphql", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({ data: { ok: true } });
    }) as typeof fetch;
    for (const id of APP_IDS) {
      set(APP, { id });
      expect(await gqlRequest<{ ok: boolean }>("{ ok }")).toEqual({ ok: true });
    }
    expect(urls).toEqual(APP_IDS.map((id) => `/v1/${id}/graphql`));
  });

  test("app prefix: no client, server or shared source builds an unprefixed /v1 API URL", () => {
    const root = path.resolve(import.meta.dir, "../../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          readFileSync(full, "utf8")
            .split("\n")
            .forEach((line, i) => {
              // Comments do not request anything; a line marked `legacy-url` reads an old setting, it builds nothing.
              if (line.includes("legacy-url")) return;
              const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
              // A string or template literal starting `/v1/graphql`, `/v1/frames`, `/v1/ingest` or `/v1/media`.
              if (/["'`]\/v1\/(graphql|frames|ingest|media)\b/.test(code)) offenders.push(`${path.relative(root, full)}:${i + 1}`);
            });
        }
      }
    };
    for (const dir of ["client", "server", "shared", "app"]) walk(path.join(root, dir));
    expect(offenders).toEqual([]);
  });
});
