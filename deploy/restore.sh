#!/bin/sh
# Restore every app's two SQLite databases (<data>/<app>/{observations,team}.db) from R2
# when they are missing on disk.
# Runs as the inversa user with /etc/inversa/env loaded: as ExecStartPre of
# inversa-api.service (every start), and from bootstrap.sh before the first start.
#   -if-db-not-exists   exit 0 when the local file is already there (normal restart)
#   -if-replica-exists  exit 0 when R2 has no backup yet (very first boot)
# Any other error (bad credentials, R2 unreachable, corrupt replica) exits non-zero
# so the API does not start on an empty database and fork the replica history.
set -eu

CONFIG="${LITESTREAM_CONFIG:-/opt/inversa/deploy/litestream.yml}"
DATA_DIR="${INVERSA_DATA_DIR:-/var/lib/inversa}"
LITESTREAM="${LITESTREAM_BIN:-/usr/local/bin/litestream}"

# Pre-pivot single-app files at the root mean migrate-app-dirs.sh has not run. Starting
# now would give python an empty database next to the real one, so stop here.
for db in observations team; do
  if [ -e "$DATA_DIR/$db.db" ]; then
    echo "restore: $DATA_DIR/$db.db is the old single-app layout; run deploy/migrate-app-dirs.sh first" >&2
    exit 1
  fi
done

for app in carp lionfish python; do
  mkdir -p "$DATA_DIR/$app"
  for db in observations team; do
    "$LITESTREAM" restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DATA_DIR/$app/$db.db"
  done
done
