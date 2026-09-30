# Deploy

One Hetzner VM runs everything behind Caddy at `inversa.calvinmaighan.dev`:

| Unit | Listens | Runs |
|---|---|---|
| `caddy` | :80, :443 | TLS; `/v1/*` and `/health` go to 4041 (WebSockets included), everything else to 3050; COOP, COEP and CORP on every response |
| `inversa-api` | 127.0.0.1:4041 | `/opt/inversa/api/inversa-api`; restores missing DBs from R2 first (`restore.sh` as `ExecStartPre`) |
| `inversa-web` | 127.0.0.1:3050 | `bun /opt/inversa/web/apps/web/server.js`, a single process, because voice sessions live in memory |
| `inversa-litestream` | - | replicates `/var/lib/inversa/{observations,team}.db` to R2 bucket `inversa-litestream` |

Paths on the box:

- `/opt/inversa/releases/<version>`: unpacked releases. The three newest are kept.
- `/opt/inversa/current`: points at the live release. `/opt/inversa/{api,web,deploy}` link through it.
- `/var/lib/inversa`: the databases and the web cache. It is the only writable path for the units.
- `/etc/inversa/env`: rendered from Doppler `inversa`/`prd` on every deploy (`root:inversa`, `0640`).

## Workflows

- `release.yml` runs on a `v*` tag or by manual dispatch. It builds `inversa-api` on ubuntu-24.04 with `cargo build --release --locked` and the Next standalone tree with bun. It then uploads one artifact, `inversa-release` (`inversa.tar.zst`, `SHA256SUMS`, `release.json`), kept for 90 days.
- `deploy.yml` runs only by manual dispatch. It downloads the artifact from a release run (blank means the latest successful run) and renders the env from Doppler. It then uses scp to copy everything to `root@HETZNER_HOST` and runs `remote-unpack.sh`, which installs the units and Caddyfile, restarts the units, and health-checks 4041 and 3050. To roll back, dispatch it again with an older run id.
- `workers.yml` runs `wrangler deploy` for `apps/signal-worker`, either on a push to `main` that touches it or by manual dispatch.

## Human checklist

Nothing here holds a secret value. Values go only into Doppler or GitHub secrets.

### H1: VM and SSH

- [ ] Create a Hetzner Cloud CX22 (x86_64) running Ubuntu 24.04, and add an SSH public key for `root`.
- [ ] Make a dedicated deploy key pair. Add the public half to `/root/.ssh/authorized_keys` on the VM.
- [ ] Add the GitHub repository secrets:
  - `HETZNER_HOST`: the VM's IPv4 address or hostname, with no `user@`.
  - `HETZNER_SSH_KEY`: the private half of the deploy key.
- [ ] Bootstrap the host once:
  ```sh
  scp deploy/bootstrap.sh root@<host>:/root/
  ssh root@<host> sh /root/bootstrap.sh
  ```
  This installs Caddy, bun 1.3.14 and Litestream 0.5.17 (bun and Litestream are checksum-verified). It also creates the `inversa` user and its directories, and opens ports 22, 80 and 443 (443 over both TCP and UDP) in ufw.

### H2: DNS

- [ ] Create an `A` record (and `AAAA` if IPv6 is used) for `inversa.calvinmaighan.dev` that points at the VM.
  - Caddy gets its own Let's Encrypt certificate, so the record must reach the VM on ports 80 and 443.
  - If Cloudflare proxies it, use SSL mode "Full (strict)".

### H3: Cloudflare R2 and TURN

- [ ] Create the R2 buckets:
  - `inversa-raw`: the raw archive.
  - `inversa-litestream`: database replicas.
  - `inversa-signal`: add a 1-day lifecycle rule.
- [ ] Create an R2 API token with Object Read and Write on those buckets. Note its access key id and secret.
- [ ] Create a Cloudflare Realtime TURN key.
- [ ] Create a Cloudflare API token with Workers Scripts Edit, scoped to the single account that owns the worker. Add it as the GitHub repository secret `CLOUDFLARE_API_TOKEN`.

### H8: Doppler

- [ ] Create the Doppler project `inversa` with the configs `dev` and `prd`.
- [ ] In `prd`, set these secrets. The first three are required: `deploy.yml` refuses to ship without them, because Litestream restore and replication need them. The others enable their own features.
  - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  - `R2_BUCKET_RAW` (`inversa-raw`)
  - `OPENROUTER_API_KEY` (the agent: `openai/gpt-6-luna` on OpenRouter; set in `dev` and `prd`. Without it `/api/agent/stream` answers 503), `XAI_API_KEY`
  - `CESIUM_ION_TOKEN`: `release.yml` inlines it into the client bundle as `NEXT_PUBLIC_CESIUM_ION_TOKEN`.
  - `GOES_SQS_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
  - `NWWS_USER`, `NWWS_PASS` (optional)
  - `INGEST_HOOK_SECRET`
  - `CF_TURN_KEY_ID`, `CF_TURN_KEY_TOKEN`
- [ ] Do not set `INVERSA_BIND`, `INVERSA_DATA_DIR` or `INVERSA_API_ORIGIN` in Doppler. The units pin them, and an env file entry would override the pin.
- [ ] Create a Doppler service token for `inversa`/`prd`. Add it as the GitHub repository secret `DOPPLER_TOKEN`. Both `release.yml` and `deploy.yml` use it.

### First deploy

1. Run `release` (tag `v0.1.0`, or dispatch it by hand) and wait until it succeeds.
2. Run `deploy` with `release_run_id` blank.
3. Check it:
   - `curl -sI https://inversa.calvinmaighan.dev/` shows `cross-origin-opener-policy: same-origin` and `cross-origin-embedder-policy: require-corp`.
   - `curl https://inversa.calvinmaighan.dev/health` returns `ok`.

## Restore drill

Run this on the VM as root. It proves that R2 holds a restorable copy.

```sh
systemctl stop inversa-litestream inversa-api
mkdir -p /root/drill
# Move the db, its -wal/-shm sidecars and Litestream's local metadata, as on a fresh disk.
mv /var/lib/inversa/observations.db* /var/lib/inversa/.observations.db-litestream /root/drill/
systemctl start inversa-api          # ExecStartPre restores from R2
journalctl -u inversa-api -n 20      # expect litestream restore output
systemctl start inversa-litestream
sqlite3 /var/lib/inversa/observations.db 'pragma integrity_check; select count(*) from sightings;'
```

A rebuilt VM follows the same path: bootstrap first, then deploy. The API restores both databases before its first start.
