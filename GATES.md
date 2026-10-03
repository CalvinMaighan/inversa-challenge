# Gates: first-run experience (species gate, voice welcome, background preload of all 3 apps)

Branch: polish-for-review (PR #5). Checks run from the repo root.

- [x] G1 Every page load starts with the UI hidden and only the zoomed-out globe behind a fixed, blurred full-screen species gate (no flash of the HUD before hydration).
  CHECK: cd apps/web && bun test tests/client/intro 2>&1 | grep -E "^ *[0-9]+ fail"
  EXPECT: 0 fail
  EVIDENCE: head script sets html[data-intro] + window.__inversaIntro before paint, CSS hides [data-slot=hud|side] (client/intro/bootstrap.ts, tests: bootstrap.test.ts); gate server-rendered in app/page.tsx. Found in the browser: React strips the attribute on hydration, so the gate restores it in a layout effect (docs/intro.md). Screenshot docs/evidence/intro-gate-pick.jpg shows only the globe and the gate.

- [x] G2 The gate asks for one of the 3 species (icons, names, a one-line question each, game-menu styling); the first click selects and switches the app, the second click ("Enter") asks for the microphone.
  EVIDENCE: client/intro/Intro.tsx; store.choose switches the app (tests/client/intro/store.test.ts "first click switches ..."); docs/evidence/intro-gate-enter.jpg (Lionfish selected, other cards dimmed, Enter button, loading bar).

- [x] G3 After the microphone is granted: the gate blurs out, the UI fades in, the globe flies to the species' area at 5,000 km, and the voice welcomes the user to the "Inversa Experience" and asks how it can help. A denied microphone has a visible "continue without voice" path.
  EVIDENCE: store.enter(true) awaits startVoice({welcome:true}) then reveal() (entryView 5,000,000 m, 1.1 s blur-out). Browser pane: "Continue without voice" opened the app at c=18.6,-81.25,5000000 (docs/evidence/intro-entered-lionfish.jpg); Enter with the microphone blocked showed "Permission denied. Allow the microphone ..." and kept the gate. NOT verified live: the granted-microphone path with real audio (the pane blocks capture); covered by relay.test.ts "first-run session opens with the spoken welcome" against the mocked xAI socket.

- [x] G4 The voice agent recommends clicking dots to view a sighting and reminds once that the source website is one click away (voice prompt, welcome greeting, text agent prompt).
  CHECK: cd apps/web && bun test tests/server/voice 2>&1 | grep -E "^ *[0-9]+ fail"
  EXPECT: 0 fail
  EVIDENCE: voice-prompt.ts "# Showing the data" and greetingInstructions({welcome}); server/agent/prompt.ts "## Showing the data"; tests/server/voice/welcome.test.ts (4) and relay.test.ts.

- [x] G5 All 3 apps' 2-year data is warmed in the background from the first moment: carp sightings into the shared store, lionfish and python frame chunks through the HTTP cache (same URLs the db worker asks for), so choosing a species is fast. The agent's tools reach the same 2 years.
  EVIDENCE: client/intro/preload.ts. Network log in the pane at python start: 24 GET /v1/lionfish/frames?...&step=60 (2024-10-03 to 2026-10-03, newest first, all 200) plus GET /v1/carp/sightings. API chunk max-age 60 -> 300 (frames.rs). Agent: carp_sightings default 730 days (earlier); python/lionfish sightings tool hours max 90 days -> 731 days (capabilities.ts MAX_SIGHTING_HOURS). Tests: preload.test.ts (chunk plan, 23 to 26 chunks, newest first, <= 744 frames).

- [x] G6 Skip switch for tests and dev: `?intro=0`, and automated browsers skip the gate unless `?intro=1`, so the existing e2e scripts' flows are unchanged.
  EVIDENCE: bootstrap.test.ts (4 cases: marks, ?intro=0, webdriver skip, ?intro=1 forces). The Playwright e2e scripts were NOT re-run in this pass (they need the full stack); the skip relies on navigator.webdriver, which Playwright sets.

- [x] G7 Whole suite green: bun run check (lint, typecheck, bun test, cargo test).
  CHECK: cd apps/web && bun run test 2>&1 | grep -E " fail$"
  EXPECT: 0 fail
  EVIDENCE: bun 1256 pass 0 fail (169 files, was 1234); check CHECK-OK with cargo 404 passed 0 failed (before the agent tool change; bun test tests/server/agent 181 pass after it).

- [x] G8 Verified in the browser pane (screenshots of the gate, the second step and the entered app), committed and pushed on the branch, PR body updated.
  EVIDENCE: docs/evidence/intro-gate-pick.jpg, intro-gate-enter.jpg, intro-entered-lionfish.jpg; commit 44d1102 pushed to polish-for-review; PR https://github.com/CalvinMaighan/inversa-challenge/pull/5 body has the "first-run gate" section.
