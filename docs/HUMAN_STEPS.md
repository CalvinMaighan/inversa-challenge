# Human steps: deploy, secrets, sign-ups

Everything here needs an account owner's login, payment details, an email click or a judgement call, so the agent did none of it (R19 in `docs/OVERNIGHT_BRIEF.md`: production-ready, not deployed). Nothing was pushed, deployed or entered. Do the steps in order; each one says the exact command or URL, why it matters and what breaks without it. Secret **values** go only into Doppler or GitHub secrets, never into this repository, a chat or a shell history.

The target is one Hetzner VM serving `https://inversa.calvinmaighan.dev` with three apps: carp (default), lionfish and python. Caddy sends `/v1/*` and `/health` to Axum, `/signal/*` to the Cloudflare signal Worker and the rest to Next (`deploy/Caddyfile`). Background: `deploy/README.md` (units, paths, migration, restore drill), `docs/security.md`, `docs/ingest-modes.md`.

## 0. Push the branch

```sh
git push origin pivot/three-apps          # then open a PR into main, or push main after review
```

- Why: the release workflow builds from GitHub, and the work lives only on local branches.
- Without it: nothing below can build a release.

## 1. Hetzner VM

1. Console: <https://console.hetzner.cloud> → Add server → Ubuntu 24.04, type CX22 (x86_64), your SSH key for `root`.
2. Make a deploy key pair just for GitHub Actions and authorise it on the VM:
   ```sh
   ssh-keygen -t ed25519 -N '' -f ~/.ssh/inversa-deploy
   ssh-copy-id -i ~/.ssh/inversa-deploy.pub root@<vm-ip>
   ```
3. Bootstrap the host once (Caddy, bun 1.3.14 and Litestream 0.5.17 checksum-verified, the `inversa` user, ufw 22/80/443):
   ```sh
   scp deploy/bootstrap.sh root@<vm-ip>:/root/ && ssh root@<vm-ip> sh /root/bootstrap.sh
   ```

- Why: the release runs here; nothing compiles on the host.
- Without it: no server; `deploy.yml` fails at its first `ssh`.

## 2. DNS

- At the DNS host of `calvinmaighan.dev`: an `A` record `inversa` → the VM's IPv4 (and `AAAA` if you use IPv6).
- Check: `dig +short inversa.calvinmaighan.dev` prints the VM address.
- Why: Caddy gets its Let's Encrypt certificate over HTTP-01/TLS-ALPN-01 on ports 80/443 of that name. If Cloudflare proxies the record, use SSL mode "Full (strict)".
- Without it: no certificate, so the site does not load over HTTPS.

## 3. Cloudflare: R2 buckets, API tokens, signal Worker, TURN

1. R2 buckets (dashboard → R2, or wrangler):
   ```sh
   bunx wrangler@4.145.0 r2 bucket create inversa-litestream
   bunx wrangler@4.145.0 r2 bucket create inversa-raw
   bunx wrangler@4.145.0 r2 bucket create inversa-signal
   bunx wrangler@4.145.0 r2 bucket lifecycle add inversa-signal expire-1d rooms/ --expire-days 1
   ```
   - Why: `inversa-litestream` holds the six database replicas (3 apps × observations and team); `inversa-raw` the raw payload archive; `inversa-signal` the WebRTC rendezvous objects, expired after a day.
   - Without it: no backups (a lost disk loses every sighting and board), no raw archive (the API falls back to local disk), no Worker storage.
2. R2 API token: dashboard → R2 → Manage R2 API Tokens → Create, Object Read & Write on those three buckets. Note the account id, access key id and secret for step 5.
3. Cloudflare API token for wrangler: <https://dash.cloudflare.com/profile/api-tokens> → Create → "Edit Cloudflare Workers" template, scoped to the one account. It becomes the GitHub secret `CLOUDFLARE_API_TOKEN` (step 6).
4. TURN key: dashboard → Realtime → TURN Server → Create. Then:
   ```sh
   cd apps/signal-worker
   bunx wrangler@4.145.0 secret put CF_TURN_KEY_ID
   bunx wrangler@4.145.0 secret put CF_TURN_KEY_TOKEN
   ```
   - Without it: `/turn` serves public STUN only, so peers behind strict NATs cannot connect; board edits still sync through the API.
5. Deploy the Worker (or let `workers.yml` do it after the push): `cd apps/signal-worker && bun run deploy`, then `curl -i https://inversa-signal.<account-subdomain>.workers.dev/rooms/demo/peers` should answer `200 []`. That origin is `SIGNAL_WORKER_URL` in step 5.
   - Without it: `/signal/*` answers 502, `/api/health` shows the Worker down, live typing and presence between browsers stop; board edits still sync through the API.

## 4. OpenRouter key and its limit

1. <https://openrouter.ai/settings/keys> → Create key, name `inversa-prd`, **credit limit $5** (or the `AGENT_DAILY_USD` you choose), limit reset daily if offered.
2. Add credits at <https://openrouter.ai/settings/credits>.

- Why: the agent is GPT-6 Luna through OpenRouter. The app enforces its own caps (per IP 10 requests a minute, $2 per app and $5 overall a day, 4 turns at once; `apps/web/server/agent/budget.ts`), but those live in one process; the key limit is the backstop if a bug or a restart loop gets past them.
- Without the key: `/api/agent/stream` answers 503 `agent_unavailable` and the chat says so. Without the limit: a defect could spend whatever credit the account holds.

## 5. Doppler `inversa` / `prd` (names only)

<https://dashboard.doppler.com> → project `inversa` → config `prd`. Set:

| Name | Needed for | Without it |
|---|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Litestream backup and restore | `deploy.yml` refuses to ship |
| `R2_BUCKET_RAW` (`inversa-raw`) | raw archive in R2 | archive on local disk only |
| `CESIUM_ION_TOKEN` | globe imagery (inlined at build) | `release.yml` fails |
| `OPENROUTER_API_KEY` | the agent | agent 503, chat says unavailable |
| `XAI_API_KEY` | voice mode | voice says unavailable |
| `INGEST_HOOK_SECRET` (32+ random bytes: `openssl rand -hex 32`) | signed ingest hook (`/v1/{app}/ingest/hook/{source}`, any poll source the app runs) | hook answers 503 |
| `INGEST_NUDGE_TOKEN` (`openssl rand -hex 24`) | provider nudges (step 10, 11) | nudges 503; feeds still poll on their backstop cadence |
| `SIGNAL_WORKER_URL` (the `https://…workers.dev` origin from step 3.5) | Caddy `/signal/*` and `/api/health` | `/signal/*` 502, Worker reported down |
| `GOES_SQS_URL` (or `GOES_SQS_URL_LIONFISH`, `GOES_SQS_URL_PYTHON`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | GOES-19 push (step 7) | `goes19` / `goes19-sst` chips down with the reason |
| `NWWS_USER`, `NWWS_PASS` | NWWS-OI push (step 8) | `nwws` chip down; alerts come from the 60 s poller |
| `USGS_API_KEY` | higher USGS rate limit (step 9) | anonymous per-IP limit, slower backoff recovery |
| `CF_TURN_KEY_ID`, `CF_TURN_KEY_TOKEN` | only if the Worker reads them from Doppler; normally set with `wrangler secret put` | STUN only |
| optional: `AGENT_DAILY_USD`, `AGENT_APP_DAILY_USD`, `AGENT_MAX_CONCURRENT`, `AGENT_RATE_PER_MIN`, `VOICE_DAILY_MINUTES` | tuning the caps | defaults $5, $2, 4, 10/min, 60 min |

Do **not** set `INVERSA_BIND`, `INVERSA_DATA_DIR`, `INVERSA_API_ORIGIN`, `INVERSA_SOURCES` or `NEXT_PUBLIC_INVERSA_E2E`: the units pin the first three, and the last two would turn ingestion off or ship the diagnostics hook.

Then: Access → Service Tokens → Generate for `inversa` / `prd` (read). That is the GitHub secret `DOPPLER_TOKEN`.

## 6. GitHub Actions secrets

<https://github.com/><owner>/<repo>/settings/secrets/actions → New repository secret:

| Secret | Value | Used by |
|---|---|---|
| `DOPPLER_TOKEN` | the service token from step 5 | `release.yml`, `deploy.yml` |
| `HETZNER_HOST` | the VM IPv4 or hostname, no `user@` | `deploy.yml` |
| `HETZNER_SSH_KEY` | contents of `~/.ssh/inversa-deploy` (private half) | `deploy.yml` |
| `CLOUDFLARE_API_TOKEN` | the token from step 3.3 | `workers.yml` |

- Without them: each workflow stops at its "Check secrets" step with `::error::secret … is not set`.

## 7. AWS: GOES-19 push (account, SQS queue, SNS subscription)

Follow `deploy/aws/README.md` ("Console steps" or "CLI steps"): an AWS account (<https://portal.aws.amazon.com/billing/signup>), region us-east-1, SQS queue `goes19-nodd` (visibility 300 s, retention 1 h, wait 20 s) with the access policy, an SNS subscription to `arn:aws:sns:us-east-1:123901341784:NewGOES19Object` with the body-scoped filter policy, and an IAM user limited to that queue. Put `GOES_SQS_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` in Doppler `prd`. Lionfish and python each need their **own** queue and subscription (`GOES_SQS_URL_LIONFISH`, `GOES_SQS_URL_PYTHON`): two apps on one queue split the messages.

- Why: GOES-19 sea and land surface temperature arrive by push within a minute of NOAA publishing.
- Without it: `goes19` (python) and `goes19-sst` (lionfish) show down with "GOES_SQS_URL … not set"; the rest of each app works.

## 8. NWWS-OI account (10+ days)

Email `NWWS.Issue@noaa.gov` asking for an NWWS Open Interface account (name, organisation, contact, purpose). Approval takes 10 days or more. Then set `NWWS_USER`, `NWWS_PASS` in Doppler `prd`.

- Why: NWS warnings by XMPP push, seconds after issuance.
- Without it: `nwws` chip down with the reason; alerts still arrive from the 60 s `nws` / `nws-alerts` pollers.

## 9. USGS Water Data API key

<https://api.waterdata.usgs.gov/signup> → free key → `USGS_API_KEY` in Doppler `prd`.

- Why: the anonymous per-IP limit is low; carp polls every gauge every 15 min.
- Without it: polls run anonymously and back off when USGS answers 429.

## 10. IEMBot webhooks (carp nudges)

Sign in at <https://weather.im/iembot/config/> (Google sign-in) and add a webhook per room, each pointing at a nudge URL with the token from step 5:

| Room | URL |
|---|---|
| `lixchat`, `lchchat`, `shvchat` (warnings) | `https://inversa.calvinmaighan.dev/v1/carp/ingest/nudge/nws-alerts/<INGEST_NUDGE_TOKEN>` |
| same rooms, flood products if the form allows a second hook | `https://inversa.calvinmaighan.dev/v1/carp/ingest/nudge/nwps/<INGEST_NUDGE_TOKEN>` |

- Check: `curl -X POST https://inversa.calvinmaighan.dev/v1/carp/ingest/nudge/nws-alerts/<token>` answers 202 `accepted`, then 200 `duplicate` within 60 s. Caddy masks the token in its access log.
- Without it: carp alerts wait for the 60 s poll and NWPS forecasts for the 15 min loop.

## 11. ERDDAP subscription (lionfish nudge)

<https://pae-paha.pacioos.hawaii.edu/erddap/subscriptions/add.html> → dataset `dhw_5km`, your email, action URL `https://inversa.calvinmaighan.dev/v1/lionfish/ingest/nudge/crw/<INGEST_NUDGE_TOKEN>` → submit, then click the validation link in the email.

- Without it: Coral Reef Watch updates land on the 3 h backstop poll instead of minutes after publication.

## 12. First release, deploy and smoke

1. Release: push a tag (`git tag v0.1.0 && git push origin v0.1.0`) or Actions → `release` → Run workflow. Wait for green.
2. Deploy: Actions → `deploy` → Run workflow, `release_run_id` blank (latest). It renders `/etc/inversa/env` from Doppler, unpacks, migrates the data layout, restores missing databases from R2, restarts the units and waits for `/health` and `/api/health`.
3. Smoke from your laptop:
   ```sh
   curl -sI https://inversa.calvinmaighan.dev/ | grep -iE 'cross-origin-(opener|embedder)-policy|content-security-policy'
   curl -fsS https://inversa.calvinmaighan.dev/health | jq '.status, [.apps[].id]'        # "ok", ["carp","lionfish","python"]
   curl -sS https://inversa.calvinmaighan.dev/api/health | jq '.status, .api, .signal, .agent.state, [.apps[] | {id, db, downFeeds}]'
   GRADE_URL=https://inversa.calvinmaighan.dev bun run grade -- --only deploy
   ```
   `/api/health` is `degraded` (200) while an optional credential is missing and names it; `down` (503) means the API or a database is broken.
4. By hand on a laptop and a phone: open `/?app=carp`, `/?app=lionfish`, `/?app=python`; ask the agent one question in each; open a board in two browsers and type.
5. Restore drill once there is data (`deploy/README.md` "Restore drill"), so you know R2 holds a usable copy before you need it.

- Without the smoke: a broken certificate, header or credential is found by the first visitor.

## 13. Rollback

Actions → `deploy` → Run workflow with `release_run_id` = the run id of the previous good `release` run (Actions → release → the run → the number in its URL). The VM keeps the three newest releases; the deploy flips `/opt/inversa/current` and restarts.

- Databases are not rolled back: a release older than the three-app pivot cannot read the per-app layout (`deploy/README.md` "Multi-app migration").
- To restore data from before a bad write: on the VM, stop `inversa-litestream inversa-api`, move the app's `<db>.db*` aside and run `litestream restore -config /opt/inversa/deploy/litestream.yml -timestamp <RFC3339> /var/lib/inversa/<app>/<db>.db` as `inversa`, then start both units.

## 14. Globe keys: Google 3D, Cesium ion, AISStream (Developer panel)

The Developer button (a key, top right of the globe) opens "Power up the globe": one row per key in `apps/web/shared/keys.ts`, a green dot when set, a GET KEY link to the page below, and a password field for each missing key. Nothing there needs the agent; each key is optional.

| Key | Get it | What it unlocks | Where it goes |
|---|---|---|---|
| Google Maps (`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) | <https://developers.google.com/maps/documentation/tile/get-api-key>: a Google Cloud project with billing, enable **Map Tiles API**, create an API key, restrict it to HTTP referrers `https://inversa.calvinmaighan.dev/*` and `http://localhost:3050/*`, and to the Map Tiles API | the photorealistic 3D planet, loaded straight from Google before the ion route | browser: paste it in the panel (that browser only), or set it in Doppler `prd` before the release build (it is inlined at build time) |
| Cesium ion (`NEXT_PUBLIC_CESIUM_ION_TOKEN`) | <https://ion.cesium.com/tokens>: a token with the default asset scopes; add assets 1 (World Terrain), 2 (Bing aerial) and 2275207 (Google Photorealistic 3D Tiles) to My Assets | real terrain, sharper aerial imagery, and Google 3D through ion when there is no Google key | browser, as above |
| AISStream (`AISSTREAM_API_KEY`) | <https://aisstream.io/apikeys>: sign in with GitHub, create a key | live ships for carp and lionfish | server: Doppler `prd` (`doppler secrets set AISSTREAM_API_KEY`), or the panel under `bun run dev` |
| OpenRouter, xAI, AWS GOES, NWWS | sections 4, 7 and 8, and <https://console.x.ai/> for `XAI_API_KEY` | the agent, voice, GOES push, NWWS push | server, as above |

- Browser keys run in the visitor's browser, so anyone can read them: the referrer and API restriction is what protects the Google key and its bill.
- Google bills Map Tiles per root-tileset request after a monthly free allowance. Check the current price at <https://developers.google.com/maps/billing-and-pricing/pricing> before enabling billing (the price was not verified here), and set a budget alert in Google Cloud Billing. The app caps each browser at 1,000 direct sessions a month (editable in the panel's Google row) and drops to ion, then keyless imagery, at 90 % of that cap.
- Local development: server keys pasted in the panel go to `data/local-keys.env` (git-ignored, mode 0600) and `bun run dev` restarts the API and web with them. A key already in the shell or Doppler wins and shows CONFIGURED EXTERNALLY. In production the panel shows the `doppler secrets set NAME` command instead.
- Without any of these the globe still works on keyless Esri imagery.
