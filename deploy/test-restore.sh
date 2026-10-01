#!/usr/bin/env bash
# Restore drill for all three apps, local and offline: proves that deploy/litestream.yml names
# every app's two databases with the replica paths restore.sh expects, and that restore.sh
# brings each one back from a Litestream replica on a fresh disk.
#
#  1. Checks deploy/litestream.yml lists exactly <data>/<app>/{observations,team}.db for carp,
#     lionfish and python, each replicated to <app>/<db>.
#  2. Writes the same six databases (WAL mode, one marker row each) under a temp data dir and
#     replicates them with `litestream replicate` to a file replica: the production config with
#     the data dir moved and the R2 replica swapped for a local directory, nothing else changed.
#  3. Adds a second marker row while replication runs, so the restore needs the WAL, not only
#     the first snapshot.
#  4. Deletes every database, -wal/-shm sidecar and Litestream metadata directory, as on a new VM.
#  5. Runs deploy/restore.sh against that tree and checks each database's integrity and both
#     marker rows; then checks a second run is a no-op and the pre-pivot layout is refused.
#
# Needs litestream (0.5.x) and sqlite3 on PATH. Last line: RESTORE-OK apps=3, or RESTORE-FAIL.
# Usage: bash deploy/test-restore.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APPS=(carp lionfish python)
DBS=(observations team)

fail() { echo "test-restore: $*" >&2; echo "RESTORE-FAIL $*"; exit 1; }

LITESTREAM="${LITESTREAM_BIN:-$(command -v litestream || true)}"
[ -n "$LITESTREAM" ] || fail "litestream not on PATH (brew install litestream, or set LITESTREAM_BIN)"
command -v sqlite3 >/dev/null || fail "sqlite3 not on PATH"
echo "test-restore: $("$LITESTREAM" version 2>&1 | head -n 1 | sed 's/^/litestream /'), $(sqlite3 --version | cut -d' ' -f1 | sed 's/^/sqlite /')"

# 1. The production config names the six databases and their replica paths.
CONFIG="$HERE/litestream.yml"
want_dbs=""
want_replicas=""
for app in "${APPS[@]}"; do
  for db in "${DBS[@]}"; do
    want_dbs+="/var/lib/inversa/$app/$db.db"$'\n'
    want_replicas+="$app/$db"$'\n'
  done
done
got_dbs="$(sed -n 's/^  - path: //p' "$CONFIG")"$'\n'
got_replicas="$(sed -n 's/^      path: //p' "$CONFIG")"$'\n'
[ "$got_dbs" = "$want_dbs" ] || fail "litestream.yml databases differ: $(echo $got_dbs)"
[ "$got_replicas" = "$want_replicas" ] || fail "litestream.yml replica paths differ: $(echo $got_replicas)"
grep -q '^      type: s3$' "$CONFIG" || fail "litestream.yml replicas are not s3"
echo "test-restore: litestream.yml lists ${#APPS[@]} apps x ${#DBS[@]} databases with matching replica paths"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/inversa-restore.XXXXXX")"
LS_PID=""
cleanup() {
  [ -n "$LS_PID" ] && kill "$LS_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
DATA="$TMP/data"
REPLICA="$TMP/replica"
FIXTURE="$TMP/litestream.yml"

# 2. The fixture config: production's, with the data dir moved and file replicas.
{
  echo "# test-restore.sh fixture: deploy/litestream.yml with the data dir and replica moved"
  echo "dbs:"
  for app in "${APPS[@]}"; do
    for db in "${DBS[@]}"; do
      echo "  - path: $DATA/$app/$db.db"
      echo "    replica:"
      echo "      type: file"
      echo "      path: $REPLICA/$app/$db"
      echo "      sync-interval: 100ms"
    done
  done
} > "$FIXTURE"

marker() { echo "$1/$2/$3"; }
for app in "${APPS[@]}"; do
  mkdir -p "$DATA/$app"
  for db in "${DBS[@]}"; do
    sqlite3 "$DATA/$app/$db.db" "pragma journal_mode = wal; create table drill (marker text not null); insert into drill values ('$(marker "$app" "$db" first)');" >/dev/null
  done
done

"$LITESTREAM" replicate -config "$FIXTURE" > "$TMP/replicate.log" 2>&1 &
LS_PID=$!

# Wait until every replica holds something, then write the second row and let it sync.
replicated() {
  for app in "${APPS[@]}"; do
    for db in "${DBS[@]}"; do
      [ -n "$(find "$REPLICA/$app/$db" -type f 2>/dev/null | head -n 1)" ] || return 1
    done
  done
}
for _ in $(seq 1 100); do
  replicated && break
  kill -0 "$LS_PID" 2>/dev/null || { cat "$TMP/replicate.log" >&2; fail "litestream replicate exited"; }
  sleep 0.1
done
replicated || { cat "$TMP/replicate.log" >&2; fail "replicas did not appear within 10 s"; }
for app in "${APPS[@]}"; do
  for db in "${DBS[@]}"; do
    sqlite3 "$DATA/$app/$db.db" "insert into drill values ('$(marker "$app" "$db" second)');"
  done
done
sleep 2
kill "$LS_PID"
wait "$LS_PID" 2>/dev/null || true
LS_PID=""
echo "test-restore: replicated $(find "$REPLICA" -type f | wc -l | tr -d ' ') replica files for ${#APPS[@]} apps"

# 4. A fresh disk: no databases, sidecars or Litestream metadata.
for app in "${APPS[@]}"; do
  rm -rf "$DATA/$app"
done

# 5. restore.sh, as ExecStartPre runs it.
LITESTREAM_CONFIG="$FIXTURE" INVERSA_DATA_DIR="$DATA" LITESTREAM_BIN="$LITESTREAM" sh "$HERE/restore.sh" > "$TMP/restore.log" 2>&1 ||
  { cat "$TMP/restore.log" >&2; fail "restore.sh failed"; }

ok_apps=0
for app in "${APPS[@]}"; do
  ok=1
  for db in "${DBS[@]}"; do
    f="$DATA/$app/$db.db"
    [ -f "$f" ] || { echo "test-restore: $app/$db.db not restored" >&2; ok=0; continue; }
    check="$(sqlite3 "$f" 'pragma integrity_check;')"
    rows="$(sqlite3 "$f" 'select marker from drill order by rowid;' | tr '\n' ' ')"
    want="$(marker "$app" "$db" first) $(marker "$app" "$db" second) "
    if [ "$check" != ok ] || [ "$rows" != "$want" ]; then
      echo "test-restore: $app/$db.db integrity=$check rows=[$rows] want=[$want]" >&2
      ok=0
    fi
  done
  if [ "$ok" = 1 ]; then
    echo "test-restore: $app restored (observations.db, team.db: integrity ok, both marker rows)"
    ok_apps=$((ok_apps + 1))
  fi
done
[ "$ok_apps" = "${#APPS[@]}" ] || fail "only $ok_apps of ${#APPS[@]} apps restored"

# A second start is a no-op: the databases exist.
before="$(cksum "$DATA/carp/observations.db")"
LITESTREAM_CONFIG="$FIXTURE" INVERSA_DATA_DIR="$DATA" LITESTREAM_BIN="$LITESTREAM" sh "$HERE/restore.sh" >/dev/null 2>&1 || fail "second restore.sh run failed"
[ "$before" = "$(cksum "$DATA/carp/observations.db")" ] || fail "second restore.sh run changed carp/observations.db"

# The pre-pivot single-app layout is refused, so the API cannot start half migrated.
touch "$DATA/observations.db"
if LITESTREAM_CONFIG="$FIXTURE" INVERSA_DATA_DIR="$DATA" LITESTREAM_BIN="$LITESTREAM" sh "$HERE/restore.sh" >/dev/null 2>&1; then
  fail "restore.sh accepted a root-level observations.db"
fi
echo "test-restore: second run is a no-op; a root-level observations.db is refused"

echo "RESTORE-OK apps=$ok_apps"
