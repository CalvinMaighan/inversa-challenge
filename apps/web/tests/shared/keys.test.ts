import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { panelRows, splitPasted } from "client/hud/developer/model";
import { browserKey, buildTimeBrowserKeys } from "client/keys";
import {
  browserKeyStorageKey,
  ENV_NAME,
  KEY_REGISTRY,
  keyEntry,
  MAX_KEY_LENGTH,
  parseEnvFile,
  resolveBrowserKey,
  SERVER_KEY_VARS,
  serializeEnvFile,
  validKeyValue,
  type ServerKeyStatus,
} from "shared/keys";

const GODS_EYE = readFileSync(path.resolve(import.meta.dir, "../../../../docs/GODS_EYE.md"), "utf8");
const SENTINEL = "SENTINEL-DO-NOT-LEAK";

function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
}

/** The first-column variable names of the "Keys and cost" table. */
function docKeyNames(): string[] {
  const section = GODS_EYE.split("## Keys and cost")[1]!.split("\n## ")[0]!;
  return section
    .split("\n")
    .filter((l) => l.startsWith("| `"))
    .flatMap((l) => [...l.split("|")[1]!.matchAll(/`([A-Z0-9_]+)`/g)].map((m) => m[1]!));
}

describe("key registry", () => {
  test("every key in the docs/GODS_EYE.md table is in the registry (Google's under its NEXT_PUBLIC_ name)", () => {
    const names = docKeyNames();
    expect(names.length).toBeGreaterThanOrEqual(5);
    const vars = KEY_REGISTRY.flatMap((k) => k.vars as readonly string[]);
    const missing = names.filter((n) => !vars.includes(n) && !vars.includes(`NEXT_PUBLIC_${n}`));
    expect(missing).toEqual([]);
  });

  test("the eight provider rows of the spec, each with scope, purpose, links and fallback", () => {
    expect(KEY_REGISTRY.map((k) => k.label)).toEqual(["Google Maps", "Cesium ion", "AISStream", "OpenRouter", "xAI voice", "Fastino GLiDE"]);
    expect(new Set(KEY_REGISTRY.map((k) => k.id)).size).toBe(KEY_REGISTRY.length);
    for (const k of KEY_REGISTRY) {
      expect(["browser", "server"]).toContain(k.scope);
      expect(["headline", "optional"]).toContain(k.priority);
      expect(k.purpose.length).toBeGreaterThan(8);
      expect(k.fallback.length).toBeGreaterThan(8);
      expect(new URL(k.getUrl).protocol).toBe("https:");
      expect(new URL(k.manageUrl).protocol).toBe("https:");
      expect(k.vars.length).toBeGreaterThan(0);
      for (const v of k.vars) expect(v).toMatch(ENV_NAME);
      // Browser keys are build-time NEXT_PUBLIC_ values; a server key never is (Next would inline it into the page).
      for (const v of k.vars) expect(v.startsWith("NEXT_PUBLIC_")).toBe(k.scope === "browser");
    }
    expect(KEY_REGISTRY.filter((k) => k.priority === "headline").map((k) => k.id)).toEqual(["google-maps", "openrouter"]);
    expect(keyEntry("fastino")?.vars).toEqual(["FASTINO_API_KEY"]);
    expect(keyEntry("aws-goes")).toBeUndefined();
    expect(keyEntry("nwws")).toBeUndefined();
    expect(SERVER_KEY_VARS).toEqual(["AISSTREAM_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "FASTINO_API_KEY"]);
  });

  test("browser keys resolve localStorage first, then the build env; blank or failing storage falls through", () => {
    const build = { "google-maps": "build-google", "cesium-ion": "build-ion" };
    expect(browserKeyStorageKey("google-maps")).toBe("inversa:keys:google-maps");
    expect(resolveBrowserKey("google-maps", memory({ "inversa:keys:google-maps": " local-google " }), build)).toEqual({ value: "local-google", source: "local" });
    expect(resolveBrowserKey("google-maps", memory(), build)).toEqual({ value: "build-google", source: "build" });
    expect(resolveBrowserKey("google-maps", memory({ "inversa:keys:google-maps": "   " }), build)).toEqual({ value: "build-google", source: "build" });
    const throwing = { getItem: () => { throw new Error("SecurityError"); } };
    expect(resolveBrowserKey("cesium-ion", throwing, build)).toEqual({ value: "build-ion", source: "build" });
    expect(resolveBrowserKey("cesium-ion", null, {})).toEqual({ value: null, source: null });
    expect(resolveBrowserKey("cesium-ion", null, { "cesium-ion": "  " })).toEqual({ value: null, source: null });
  });

  test("the globe's browserKey reads localStorage, then NEXT_PUBLIC_* from the build env", () => {
    const saved = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = "build-google";
    try {
      expect(buildTimeBrowserKeys()["google-maps"]).toBe("build-google");
      expect(browserKey("google-maps", memory())).toBe("build-google");
      expect(browserKey("google-maps", memory({ "inversa:keys:google-maps": "local-google" }))).toBe("local-google");
      delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      expect(browserKey("google-maps", memory())).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      else process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = saved;
    }
  });

  test("server keys never expose a value: panel rows carry set, source and names only", () => {
    const store = memory({ "inversa:keys:google-maps": SENTINEL });
    const server: ServerKeyStatus[] = [
      { id: "openrouter", set: true, source: "external", writable: true, vars: [{ name: "OPENROUTER_API_KEY", set: true, source: "external" }] },
      { id: "aisstream", set: false, source: null, writable: true, vars: [{ name: "AISSTREAM_API_KEY", set: false, source: null }] },
      { id: "xai", set: false, source: null, writable: false, vars: [{ name: "XAI_API_KEY", set: false, source: null }] },
      { id: "fastino", set: false, source: "pending", writable: true, vars: [{ name: "FASTINO_API_KEY", set: false, source: "pending" }] },
    ];
    const rows = panelRows(store, server, { "cesium-ion": "build-ion" });
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    expect(JSON.stringify(rows)).not.toContain("build-ion");
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(rows.length).toBe(KEY_REGISTRY.length);
    expect(by["google-maps"]).toMatchObject({ set: true, external: false, removable: true, inputs: [], link: { label: "MANAGE" } });
    expect(by["cesium-ion"]).toMatchObject({ set: true, external: true, removable: false, inputs: [] });
    expect(by.openrouter).toMatchObject({ set: true, external: true, inputs: [], link: { label: "MANAGE" } });
    expect(by.aisstream).toMatchObject({ set: false, inputs: [{ name: "AISSTREAM_API_KEY" }], link: { label: "GET KEY", href: "https://aisstream.io/apikeys" } });
    // Not writable here (production): the Doppler command for each missing variable, no paste field.
    expect(by.xai).toMatchObject({ inputs: [], commands: ["doppler secrets set XAI_API_KEY"] });
    expect(by.fastino).toMatchObject({ pending: true, inputs: [] });
    // Status unknown (GET failed): server rows offer nothing to paste.
    expect(panelRows(memory(), null).filter((r) => r.scope === "server").every((r) => r.inputs.length === 0 && r.commands.length === 0)).toBe(true);
    // Unset browser keys get one password field each, named by the variable.
    expect(panelRows(memory(), null, {}).find((r) => r.id === "google-maps")!.inputs).toEqual([{ name: "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", label: "Google Maps NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" }]);
  });

  test("pasted values split into browser ids and server variables; blanks dropped", () => {
    expect(splitPasted({ NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: " g ", AISSTREAM_API_KEY: "a", FASTINO_API_KEY: "  ", UNKNOWN: "x" })).toEqual({
      browser: [["google-maps", "g"]],
      server: { AISSTREAM_API_KEY: "a" },
    });
  });

  test("local-keys.env: parse and serialize round-trip; values must be one printable token", () => {
    const text = serializeEnvFile({ XAI_API_KEY: "x=y", AISSTREAM_API_KEY: "abc" });
    expect(text.split("\n")[0]).toStartWith("#");
    expect(text).toContain("AISSTREAM_API_KEY=abc\nXAI_API_KEY=x=y\n");
    expect(parseEnvFile(text)).toEqual({ AISSTREAM_API_KEY: "abc", XAI_API_KEY: "x=y" });
    expect(parseEnvFile("# c\n\nlower=1\nBAD LINE\n=x\nOK=1\nEMPTY=\n")).toEqual({ OK: "1" });
    expect(validKeyValue("sk-or-v1-abc_DEF.123")).toBe(true);
    for (const bad of ["", "a b", "a\nB=c", "tab\t", "é", "x".repeat(MAX_KEY_LENGTH + 1), 42, null]) expect(validKeyValue(bad)).toBe(false);
  });
});
