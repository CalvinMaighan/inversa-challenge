# Gates: A1b Web app seam and selector popover (opus)

Contract: `PLAN.md` "Three-app contract (A0)" C-A3, C-A5, C-A6. You own: `apps/web/shared/apps/**` (new), `apps/web/client/state/app.ts` (new), `apps/web/client/hud/appselect/**` (new), share-link modules (`client/hud/share-link*.ts`, `ShareLinkSync.tsx`), `client/state/layers.ts` and other client modules only where they read `SPECIES_IDS`/`REGION_BBOX`/`LAYER_IDS`/`DEFAULT_BOARD_ID`, `client/threads/{gql,db}` request builders (app prefix), `apps/web/server/agent/{prompt.ts,config.ts,run-turn.ts,tools/*}` and `apps/web/app/api/agent/**` (per-app persona/scope/tools via config), `apps/web/server/voice/**`, `apps/web/shared/voice/ui-tools.ts`, `apps/web/eval/{run.ts,stub-server.ts}` (app param; golden sets are split per app, python keeps its 15), `apps/web/e2e/{stack.ts,dev-stack.ts}` (multi-app env), tests mirroring those files. Do NOT touch `api/**` or `spec/apps/*.json` (A1a owns them; read `spec/apps/app-config.schema.json` once it exists, otherwise code against the field list in contract C-A3 and reconcile at merge). Do not commit, do not push.

- [ ] G1: `shared/apps` loads `spec/apps/*.json` with zod, exports `APP_IDS`, `loadApps()`, `AppConfig`; a conformance test loads all three files; invalid config fails with a typed error. Test name contains `app config`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "app config" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G2: active app resolution: `?app=` beats localStorage `inversa.app` beats default `carp`; invalid values fall back to `carp`; localStorage failures are swallowed; tests named `active app`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "active app" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G3: share link `v=2` carries `app`; `v=1` links still decode (as python); round trip test named `share link app`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "share link app" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G4: every GraphQL/frames/ws request from the client and agent tools carries the app prefix (`/v1/<app>/...`); a test asserts no request URL without it; test named `app prefix`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "app prefix" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G5: agent: persona, scope text, tool allowlist and refusal text come from the app config; a test per app (use stub configs) proves the system prompt contains that app's scope and not another's, and that an off-allowlist tool is not registered; test named `agent per app`
  CHECK: cd apps/web && bun test --tsconfig-override ./tsconfig.json tests -t "agent per app" 2>&1 | grep -E "pass|fail"
  EXPECT: /[1-9][0-9]* pass[\s\S]*0 fail/
  EVIDENCE: pending

- [ ] G6: no `SPECIES_IDS`, `REGION_BBOX` or hard-coded `everglades` board id constant remains in `client/`, `server/`, `shared/` outside `shared/apps` and the python config; `DEFAULT_BOARD_ID` becomes `<app>:main`
  CHECK: grep -rnE "SPECIES_IDS|REGION_BBOX|DEFAULT_BOARD_ID *= *\"everglades\"" apps/web/client apps/web/server apps/web/shared | grep -v "shared/apps" | wc -l
  EXPECT: /^\s*0\s*$/
  EVIDENCE: pending

- [ ] G7: selector popover (HUD species icon button): lists carp, lionfish, python with icon, name, one-line question and a feed-health dot from `/health`; selecting one updates URL, localStorage, config-driven map preset, layers, helper questions and legend; Escape returns focus; keyboard operable; link behaviour matches other chrome popovers. e2e prints `APPSELECT apps=3 url=ok persist=ok keyboard=ok focus_return=ok switch_ms=<n>` with switch_ms < 500
  CHECK: cd apps/web && bun run e2e:appselect 2>&1 | grep APPSELECT
  EXPECT: /APPSELECT apps=3 url=ok persist=ok keyboard=ok focus_return=ok switch_ms=([0-9]|[1-9][0-9]|[1-4][0-9][0-9])\b/
  EVIDENCE: pending

- [ ] G8: web tests, typecheck and lint pass (state the test count and which tests were rewritten for the seam)
  CHECK: bun run --cwd apps/web test 2>&1 | grep -E "^ *[0-9]+ fail" && bun run --cwd apps/web typecheck >/dev/null 2>&1 && bun run --cwd apps/web lint >/dev/null 2>&1 && echo CLEAN
  EXPECT: /^ *0 fail[\s\S]*CLEAN/m
  EVIDENCE: pending

- [ ] G9: screenshots (looked at) of the popover open, light and dark, desktop and 375 px mobile: `docs/evidence/appselect-{dark,light,mobile}.png`
  EVIDENCE: pending
