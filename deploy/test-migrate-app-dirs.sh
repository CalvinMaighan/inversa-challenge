#!/usr/bin/env bash
# Tests migrate-app-dirs.sh on a temp tree: files land under python/, a second run changes
# nothing, and the clobber case exits non-zero without moving anything.
# Last line on success: MIGRATE-OK idempotent
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATE="$HERE/migrate-app-dirs.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# Paths and content checksums, relative to the tree root.
snapshot() {
  (cd "$1" && find . | LC_ALL=C sort && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 cksum)
}

old_layout() {
  local d="$1"
  mkdir -p "$d/.observations.db-litestream/ltx" "$d/archive/raw/inat/2026/01/01" "$d/archive/media/taxon" "$d/web-cache/next"
  echo obs >"$d/observations.db"
  echo obs-wal >"$d/observations.db-wal"
  echo obs-shm >"$d/observations.db-shm"
  echo team >"$d/team.db"
  echo team-wal >"$d/team.db-wal"
  echo meta >"$d/.observations.db-litestream/ltx/0001.ltx"
  echo raw >"$d/archive/raw/inat/2026/01/01/a.json.gz"
  echo jpg >"$d/archive/media/1"
  echo jpg >"$d/archive/media/taxon/3"
  echo keep >"$d/web-cache/next/x"
}

# 1. Migrate, then migrate again: identical trees.
D="$TMP/data"
old_layout "$D"
bash "$MIGRATE" "$D" >"$TMP/run1.log"
snapshot "$D" >"$TMP/after1"
bash "$MIGRATE" "$D" >"$TMP/run2.log"
snapshot "$D" >"$TMP/after2"
diff -u "$TMP/after1" "$TMP/after2" || fail "second run changed the tree"
grep -q "nothing to do" "$TMP/run2.log" || fail "second run did not report a no-op"

for f in python/observations.db python/observations.db-wal python/observations.db-shm python/team.db \
  python/team.db-wal python/.observations.db-litestream/ltx/0001.ltx \
  archive/python/raw/inat/2026/01/01/a.json.gz archive/python/media/1 archive/python/media/taxon/3 web-cache/next/x; do
  [ -f "$D/$f" ] || fail "missing $f after migration"
done
for f in observations.db observations.db-wal observations.db-shm team.db team.db-wal .observations.db-litestream archive/raw archive/media; do
  [ ! -e "$D/$f" ] || fail "$f still at the old path"
done
[ "$(cat "$D/python/observations.db-wal")" = obs-wal ] || fail "wal content changed"

# 2. Env var default works too (fresh tree).
E="$TMP/env"
old_layout "$E"
INVERSA_DATA_DIR="$E" bash "$MIGRATE" >/dev/null
[ -f "$E/python/team.db" ] || fail "INVERSA_DATA_DIR not honoured"

# 3. Clobber: old and new observations.db both present; exit non-zero, nothing moved.
C="$TMP/clobber"
old_layout "$C"
mkdir -p "$C/python"
echo newer >"$C/python/observations.db"
snapshot "$C" >"$TMP/before-clobber"
if bash "$MIGRATE" "$C" >"$TMP/clobber.log" 2>&1; then
  fail "clobber case exited 0"
fi
grep -q "refusing to clobber" "$TMP/clobber.log" || fail "clobber case gave no reason"
snapshot "$C" >"$TMP/after-clobber"
diff -u "$TMP/before-clobber" "$TMP/after-clobber" || fail "clobber case moved files"

# 4. Missing dir fails.
if bash "$MIGRATE" "$TMP/nope" >/dev/null 2>&1; then fail "missing dir exited 0"; fi

cat "$TMP/run1.log"
echo "MIGRATE-OK idempotent"
