import { describe, expect, test } from "bun:test";

import { appArg } from "../../e2e/args";

describe("e2e --app", () => {
  test("reads `--app <id>` and `--app=<id>`, as the rubric passes it after `--`", () => {
    expect(appArg("python", ["--app", "carp"])).toBe("carp");
    expect(appArg("python", ["--shot", "--app=lionfish"])).toBe("lionfish");
  });

  test("falls back without the flag", () => {
    expect(appArg("python", [])).toBe("python");
    expect(appArg("lionfish", ["--shot"])).toBe("lionfish");
  });

  test("an unknown id throws instead of testing the default app", () => {
    expect(() => appArg("python", ["--app", "gecko"])).toThrow(/not an app id/);
    expect(() => appArg("python", ["--app"])).toThrow(/not an app id/);
  });
});
