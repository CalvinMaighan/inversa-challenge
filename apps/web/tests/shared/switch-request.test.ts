import { describe, expect, test } from "bun:test";

import { SWITCH_REQUEST } from "shared/switch-request";

describe("switch request", () => {
  test("a request to move to another species matches, a question about one does not", () => {
    for (const q of ["Can you select the carp?", "switch to lionfish", "take me to the python app", "go to the python map"]) expect(SWITCH_REQUEST.test(q)).toBe(true);
    for (const q of ["Tell me about carp", "How many pythons were reported this week?", "Where were lionfish seen?"]) expect(SWITCH_REQUEST.test(q)).toBe(false);
  });
});
