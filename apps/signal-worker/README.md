# signal-worker

Cloudflare Worker that does WebRTC rendezvous for board rooms (PLAN C9, PRD §12 "New tech 3"). Storage is the R2 bucket `inversa-signal`, bound as `SIGNAL`.

## API

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/rooms/:room/peers` | `{peerId, name}` | 204. Announce or heartbeat. |
| GET | `/rooms/:room/peers` | | 200 `[{peerId, name, seenAt}]`, live entries only |
| POST | `/rooms/:room/inbox/:peer` | `{from, kind: "offer"\|"answer"\|"ice", payload}` | 204 |
| GET | `/rooms/:room/inbox/:peer` | | 200 `[{from, kind, payload, sentAt}]` in send order. Returned messages are deleted. |
| GET | `/turn` | | 200 `{iceServers}` |

### Peers

- Every peer in a room lives in one object, `rooms/<room>/peers.json`.
- An announce is a compare-and-swap. The worker reads the object, prunes entries older than 60 s, upserts the peer, and writes the result back.
- The write uses `onlyIf: {etagMatches}`. When the object does not exist yet, it uses `{etagDoesNotMatch: "*"}`, so two first announces can't both create it.
- A rejected write is retried with jitter, up to 12 attempts. After that the worker answers 503 with `Retry-After: 1`.
- Clients heartbeat well inside the 60 s TTL. Every 20 s is a good interval.

### Inbox

- Each message is stored as its own object, `rooms/<room>/inbox/<peer>/<ts>-<rand>.json`.
  - `ts` is the 13-digit epoch in ms.
  - `rand` is an 8-digit per-isolate sequence followed by 8 random hex digits. The sequence keeps messages sent in the same millisecond in order.
- A poll lists the prefix, reads up to 32 messages in key order, and deletes them.
  - 32 keeps one poll (list, 32 reads, 1 delete) under the Workers subrequest limit.
  - Any messages beyond 32 come back on the next poll. Clients poll every 500 ms during the handshake.

### TURN

- `/turn` needs the `CF_TURN_KEY_ID` and `CF_TURN_KEY_TOKEN` secrets. With them, it calls `POST https://rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers` with `{ttl: 3600}`.
- URLs on port 53 are dropped from the result, because browsers time out on them.
- If the secrets are missing, or the upstream call fails, `/turn` returns `stun:stun.cloudflare.com:3478` only.

### Validation, CORS and CORP

- **Validation:**
  - Room, peer and `from` ids must match `^[A-Za-z0-9_-]{1,64}$`.
  - `name` is 1–64 characters.
  - Bodies over 64 KB get 413. The limit is enforced on the bytes actually received, not just on `Content-Length`.
- **Errors** are JSON `{error}` with status 400, 403, 404, 405 (with `Allow`), 413, 503 or 500.
- **CORS:**
  - Only the origins in `ALLOWED_ORIGIN` get `Access-Control-Allow-Origin`, and that includes preflights. `ALLOWED_ORIGIN` is a comma-separated list.
  - A request from any other `Origin` gets 403 with no CORS headers, so cross-site simple POSTs can't write to inboxes.
  - Requests with no `Origin` (curl, servers) are served.
- **CORP:** every response, errors included, carries `Cross-Origin-Resource-Policy: cross-origin`. The app runs with COEP `require-corp`, so this is required. Every response also carries `Cache-Control: no-store` and `Vary: Origin`.

## Config

- `wrangler.toml` sets `ALLOWED_ORIGIN=https://inversa.calvinmaighan.dev`.
- The `dev` environment adds `http://localhost:3050` and `http://127.0.0.1:3050`.
- The secrets are set with `wrangler secret put CF_TURN_KEY_ID` and `wrangler secret put CF_TURN_KEY_TOKEN`. They are never committed.

## Scripts

| Script | What it does |
|---|---|
| `bun run test` | Unit tests against an in-memory R2 stub with etag `onlyIf` semantics (`test/mem-r2.ts`). The script unsets the AI-agent env flags so bun prints every test name. |
| `bun run typecheck` | `tsc` |
| `bun run e2e` | Starts `wrangler dev --local --env dev --port 8799` with fresh local R2 state, then runs a two-peer exchange: concurrent announce ×2, list, offer, answer, ICE both ways, inboxes drained to empty, `/turn`, 8 concurrent announces, and a denied origin. Stops wrangler and prints `EXCHANGE-OK` as its last line. |
| `bun run dev` | Local worker on :8799 |
| `bun run deploy` | `wrangler deploy`. Requires H3 to be done first. |

## H3: human steps (Cloudflare account)

Nothing here has been run. An account owner does these once:

1. Create the bucket:
   ```sh
   bunx wrangler@4.145.0 r2 bucket create inversa-signal
   ```
2. Add the 1-day lifecycle rule, so abandoned rooms and unread inbox messages expire. You can do this in the dashboard (R2 → `inversa-signal` → Settings → Object lifecycle rules → Add rule → prefix `rooms/`, delete objects after 1 day) or from the CLI:
   ```sh
   bunx wrangler@4.145.0 r2 bucket lifecycle add inversa-signal expire-1d rooms/ --expire-days 1
   ```
   Expiry counts from each object's last write. An active room's `peers.json` is rewritten on every heartbeat, so the rule never removes it.
3. Create a TURN key: dashboard → Realtime → TURN Server → Create. Store it as secrets:
   ```sh
   bunx wrangler@4.145.0 secret put CF_TURN_KEY_ID
   bunx wrangler@4.145.0 secret put CF_TURN_KEY_TOKEN
   ```
4. Run `bun run deploy`, then check `curl -i https://<worker-host>/rooms/demo/peers`. It should return `200 []` with `cross-origin-resource-policy: cross-origin`.

## Upgrade path

Durable Objects with WebSocket hibernation. They replace polling and the peers.json compare-and-swap.
