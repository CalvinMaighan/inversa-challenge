#!/bin/sh
# Runs as root on the VM, invoked over ssh by .github/workflows/deploy.yml.
# Unpacks one release, installs env, units and Caddyfile, flips /opt/inversa/current,
# restarts the units (inversa-api restores missing databases from R2 first) and
# health-checks both upstreams. Nothing is built on the host.
# Usage: remote-unpack.sh VERSION. Staging dir /var/tmp/inversa-VERSION holds
# inversa.tar.zst, SHA256SUMS and env (rendered from Doppler inversa/prd).
set -eu

VERSION="${1:?usage: remote-unpack.sh VERSION}"
case "$VERSION" in
  *[!A-Za-z0-9._-]* | .* ) echo "remote-unpack: invalid VERSION '$VERSION'" >&2; exit 1 ;;
esac

ROOT=/opt/inversa
STAGING="/var/tmp/inversa-$VERSION"
DEST="$ROOT/releases/$VERSION"

# The staged env holds every production secret; never leave it behind.
trap 'rm -rf "$STAGING"' EXIT

(cd "$STAGING" && sha256sum -c SHA256SUMS)

rm -rf "$DEST.new"
mkdir -p "$DEST.new"
tar --zstd -xf "$STAGING/inversa.tar.zst" -C "$DEST.new"
chown -R root:root "$DEST.new"
chmod -R go-w "$DEST.new"
chmod 755 "$DEST.new/api/inversa-api" "$DEST.new/deploy/restore.sh" "$DEST.new/deploy/migrate-app-dirs.sh"

# Next writes its cache under .next/cache; the release tree is read-only, so point it
# at the writable web cache (inversa-web.service allows only that path).
install -d -m 750 -o inversa -g inversa \
  /var/lib/inversa /var/lib/inversa/web-cache /var/lib/inversa/web-cache/next /var/lib/inversa/web-cache/bun
rm -rf "$DEST.new/web/apps/web/.next/cache"
ln -s /var/lib/inversa/web-cache/next "$DEST.new/web/apps/web/.next/cache"

caddy validate --config "$DEST.new/deploy/Caddyfile" --adapter caddyfile

rm -rf "$DEST"
mv "$DEST.new" "$DEST"

install -d -m 750 -o root -g inversa /etc/inversa
install -m 640 -o root -g inversa "$STAGING/env" /etc/inversa/env
install -m 644 "$DEST/deploy/inversa-api.service" "$DEST/deploy/inversa-web.service" \
  "$DEST/deploy/inversa-litestream.service" /etc/systemd/system/
install -m 644 "$DEST/deploy/Caddyfile" /etc/caddy/Caddyfile

# Atomic flip, then stable paths the units use: /opt/inversa/{api,web,deploy}.
ln -sfn "releases/$VERSION" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"
for part in api web deploy; do
  ln -sfn "current/$part" "$ROOT/$part"
done

systemctl daemon-reload
systemctl enable --quiet inversa-api inversa-litestream inversa-web caddy
# Per-app data layout (PLAN.md C-A1): move pre-pivot files into python/ while nothing holds
# the databases open. A no-op once migrated; exits non-zero (deploy fails, units stay
# stopped) if old and new files both exist.
systemctl stop inversa-litestream inversa-api
runuser -u inversa -- bash "$ROOT/deploy/migrate-app-dirs.sh" /var/lib/inversa
systemctl restart inversa-api inversa-litestream inversa-web
systemctl reload caddy || systemctl restart caddy

healthy=""
for _ in $(seq 1 60); do
  # /health is JSON; 503 (curl -f fails) or "status":"degraded" means an app is unhealthy.
  if curl -fsS http://127.0.0.1:4041/health 2>/dev/null | grep -q '"status":"ok"' && curl -fsS -o /dev/null http://127.0.0.1:3050/; then
    healthy=yes
    break
  fi
  sleep 1
done
if [ -z "$healthy" ]; then
  echo "remote-unpack: $VERSION did not become healthy within 60s" >&2
  systemctl --no-pager --lines=0 status inversa-api inversa-litestream inversa-web >&2 || true
  journalctl --no-pager -n 80 -u inversa-api -u inversa-web -u inversa-litestream >&2 || true
  exit 1
fi
echo "deployed $VERSION -> $ROOT/current"

# Keep the three newest releases for rollback (redeploy an older release run).
find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
  sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
