import { describe, expect, test } from "bun:test";
import path from "node:path";

import { serverOnlyReason } from "@/eslint-plugins/inversa/use-client-purity.mjs";

import { ids, lint } from "./lint";

const client = (body: string, filename = "client/hud/Top.tsx") => ids(lint("use-client-purity", `"use client";\n${body}`, filename));

describe("use-client-purity", () => {
  test("classifies server-only imports", () => {
    const cwd = process.cwd();
    const dir = path.join(cwd, "client/hud");
    expect(serverOnlyReason("node:crypto", dir, cwd)).toBe("a Node.js built-in");
    expect(serverOnlyReason("next/headers", dir, cwd)).toBe("a Next.js server API");
    expect(serverOnlyReason("server/agent/boot", dir, cwd)).toBe("a server-only module");
    expect(serverOnlyReason("../../server/voice/grok-realtime", dir, cwd)).toBe("a server-only module");
    expect(serverOnlyReason("@/app/api/agent/stream/route", dir, cwd)).toBe("a route handler");
    expect(serverOnlyReason("@aws-sdk/client-sqs", dir, cwd)).toBe("a server-only package");
    expect(serverOnlyReason("shared/voice/protocol", dir, cwd)).toBeNull();
    expect(serverOnlyReason("client/state", dir, cwd)).toBeNull();
    expect(serverOnlyReason("react", dir, cwd)).toBeNull();
  });

  test("rejects server imports in a client module", () => {
    expect(client('import { boot } from "server/agent/boot";')).toEqual(["serverOnlyImport"]);
    expect(client('import fs from "node:fs";')).toEqual(["serverOnlyImport"]);
    expect(client('export * from "server/voice/voice-session";')).toEqual(["serverOnlyImport"]);
    expect(client('const m = () => import("server/agent/boot");')).toEqual(["serverOnlyImport"]);
  });

  test("allows type-only imports: they are erased before bundling", () => {
    expect(client('import type { Limits } from "server/agent/limits";')).toEqual([]);
    expect(client('export type { Limits } from "server/agent/limits";')).toEqual([]);
  });

  test("rejects private env reads, allows NEXT_PUBLIC_* and NODE_ENV", () => {
    expect(client("const k = process.env.XAI_API_KEY;")).toEqual(["unsafeEnv"]);
    expect(client('const k = process.env["FIREWORKS_API_KEY"];')).toEqual(["unsafeEnv"]);
    expect(client("const t = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN;")).toEqual([]);
    expect(client('const dev = process.env.NODE_ENV !== "production";')).toEqual([]);
  });

  test("ignores modules without the directive", () => {
    expect(ids(lint("use-client-purity", 'import fs from "node:fs";\nconst k = process.env.XAI_API_KEY;', "server/agent/x.ts"))).toEqual([]);
  });
});
