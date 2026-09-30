#!/bin/sh
# Host setup for a fresh Hetzner Ubuntu 24.04 VM (CX22, x86_64). Idempotent. Run as root:
#   scp deploy/bootstrap.sh root@HOST:/root/ && ssh root@HOST sh /root/bootstrap.sh
# Installs Caddy, bun and Litestream, creates the inversa user and its directories,
# and opens the firewall. Releases, units, the Caddyfile and /etc/inversa/env are
# shipped by .github/workflows/deploy.yml (see deploy/remote-unpack.sh).
#
# If a release and /etc/inversa/env are already present (a rebuilt box after the
# first deploy, or a re-run), it restores both databases from R2 when missing and
# only then starts the API, Litestream and web units.
set -eu

BUN_VERSION=1.3.14
LITESTREAM_VERSION=0.5.17

if [ "$(id -u)" -ne 0 ]; then
  echo "bootstrap: run as root" >&2
  exit 1
fi
if [ "$(uname -m)" != x86_64 ]; then
  echo "bootstrap: expected an x86_64 host, got $(uname -m)" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https \
  unzip zstd jq sqlite3 ufw

# Caddy: TLS and reverse proxy, from the official Cloudsmith apt repository.
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# bun: runs the Next standalone server. Pinned to the CI version, checksum-verified.
if [ "$(/usr/local/bin/bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  # The default build needs AVX2; fall back to the baseline build on older vCPUs.
  if grep -qw avx2 /proc/cpuinfo; then asset=bun-linux-x64; else asset=bun-linux-x64-baseline; fi
  base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
  curl -fsSLo "$TMP/$asset.zip" "$base/$asset.zip"
  curl -fsSLo "$TMP/bun-SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$TMP" && grep -E "[ *]${asset}\.zip\$" bun-SHASUMS256.txt | sha256sum -c -)
  unzip -q -o "$TMP/$asset.zip" -d "$TMP"
  install -m 755 "$TMP/$asset/bun" /usr/local/bin/bun
fi

# Litestream: SQLite replication to R2. Pinned, checksum-verified.
if ! /usr/local/bin/litestream version 2>/dev/null | grep -qF "$LITESTREAM_VERSION"; then
  tarball="litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"
  base="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}"
  curl -fsSLo "$TMP/$tarball" "$base/$tarball"
  curl -fsSLo "$TMP/litestream-checksums.txt" "$base/checksums.txt"
  (cd "$TMP" && grep -E "[ *]${tarball}\$" litestream-checksums.txt | sha256sum -c -)
  mkdir -p "$TMP/litestream-x"
  tar -xzf "$TMP/$tarball" -C "$TMP/litestream-x"
  bin="$(find "$TMP/litestream-x" -type f -name litestream | head -n 1)"
  test -n "$bin" || { echo "bootstrap: no litestream binary in $tarball" >&2; exit 1; }
  install -m 755 "$bin" /usr/local/bin/litestream
fi

# Service user and directories. Release code is root-owned and read-only to services.
id inversa >/dev/null 2>&1 ||
  useradd --system --user-group --home-dir /var/lib/inversa --no-create-home --shell /usr/sbin/nologin inversa
install -d -m 750 -o inversa -g inversa \
  /var/lib/inversa /var/lib/inversa/web-cache /var/lib/inversa/web-cache/next /var/lib/inversa/web-cache/bun
install -d -m 755 -o root -g root /opt/inversa /opt/inversa/releases
install -d -m 750 -o root -g inversa /etc/inversa

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

systemctl enable --now caddy

if [ -e /opt/inversa/current ] && [ -f /etc/inversa/env ]; then
  # Restore before the API ever starts, with the same user and env file as the units.
  # inversa-api.service repeats this as ExecStartPre, so a reboot is covered too.
  systemd-run --quiet --wait --pipe --collect \
    --uid=inversa --gid=inversa \
    -p EnvironmentFile=/etc/inversa/env \
    -p Environment=INVERSA_DATA_DIR=/var/lib/inversa \
    /opt/inversa/deploy/restore.sh
  systemctl daemon-reload
  systemctl enable --now inversa-api inversa-litestream inversa-web
  echo "bootstrap: databases restored (if missing) and units started"
else
  echo "bootstrap: no release yet; run the deploy workflow (inversa-api restores from R2 on first start)"
fi

echo "bootstrap done: $(caddy version | head -n 1), bun $(/usr/local/bin/bun --version), litestream $(/usr/local/bin/litestream version)"
