# Gates: T3 Next shell, themes, state catalog, ESLint rules (opus)

Scope: app layout with pre-paint theme bootstrap, active-theme light/dark/tactical from big-value palettes, active-state catalog keys, Providers, COOP/COEP, /v1 rewrite, self-hosted fonts, ported big-value ESLint rules that apply.

- [x] G1: all state keys from PLAN are registered in the catalog
  CHECK: for k in TIME VIEW LAYERS SELECTION FEEDS MISSIONS PEERS ME AGENT_CARD AGENT_CHAT VOICE; do grep -rq "\"$k\"" apps/web/client/state || m=$((m+1)); done; echo "missing=${m:-0}"
  EXPECT: missing=0
  EVIDENCE: missing=0

- [x] G2: three theme modes defined
  CHECK: grep -rhoE "\b(light|dark|tactical)\b" apps/web/client/themes | sort -u | tr '\n' ' '
  EXPECT: dark light tactical
  EVIDENCE: dark light tactical

- [x] G3: production build succeeds
  CHECK: bun run --cwd apps/web build 2>&1 | grep -c "Route (app)"
  EXPECT: 1
  EVIDENCE: 1

- [x] G4: served pages carry COOP and COEP
  CHECK: cd apps/web && (PORT=3099 HOSTNAME=127.0.0.1 bun .next/standalone/apps/web/server.js >/tmp/t3-srv.log 2>&1 &) && sleep 3 && curl -sI http://127.0.0.1:3099/ | tr -d '\r' | grep -iE "cross-origin-(opener|embedder)-policy" ; pkill -f "standalone/apps/web/server.js" || true
  EXPECT: /opener-policy: same-origin[\s\S]*embedder-policy: require-corp|embedder-policy: require-corp[\s\S]*opener-policy: same-origin/i
  EVIDENCE: Cross-Origin-Opener-Policy: same-origin | Cross-Origin-Embedder-Policy: require-corp

- [x] G5: crossOriginIsolated is true in a real browser and theme toggles between the 3 modes (manual: in-app browser or Playwright; quote the evaluated values)
  EVIDENCE: standalone server.js on 127.0.0.1:3097 (static+public copied in), Playwright 1.62 chromium: `{"crossOriginIsolated":true,"sab":"function","dataTheme":"dark"}`; bus toggle via shared THEME key: light `{"dataTheme":"light","bg":"oklch(1 0 0)"}`, tactical `{"dataTheme":"tactical","bg":"oklch(0.16 0.012 160)"}`, dark `{"dataTheme":"dark","bg":"oklch(0.225 0.01 294.8)"}`; real second-tab write → tab 1 `data-theme: tactical`; reload with stored tactical: data-theme writes `[{"value":"tactical","bodyExists":false,"readyState":"loading"},{"value":"tactical","bodyExists":true,"readyState":"complete"}]` (no dark in between); console errors/warnings: none. In-app browser pane: `self.crossOriginIsolated === true`, fonts loaded, 0 failed resources.

- [x] G6: no data-theme flash: layout.tsx contains an inline pre-paint script that sets data-theme before hydration
  CHECK: grep -c "data-theme" apps/web/app/layout.tsx
  EXPECT: /[1-9]/
  EVIDENCE: 2

- [x] G7: fonts are self-hosted (no fonts.googleapis/gstatic references)
  CHECK: grep -rE "fonts\.(googleapis|gstatic)" apps/web/app apps/web/client | wc -l | tr -d ' '
  EXPECT: /^0$/m
  EVIDENCE: 0

- [x] G8: lint and typecheck clean
  CHECK: bun run --cwd apps/web lint >/dev/null 2>&1 && bun run --cwd apps/web typecheck >/dev/null 2>&1 && echo CLEAN
  EXPECT: CLEAN
  EVIDENCE: CLEAN
