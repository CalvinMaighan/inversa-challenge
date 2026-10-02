#!/usr/bin/env bash
# One-time move of the pre-pivot single-app data (python only) into the per-app layout
# (PLAN.md C-A1): <dir>/{observations,team}.db -> <dir>/python/{observations,team}.db.
# Moves each database with its -wal/-shm sidecars and Litestream's local metadata
# (.<db>-litestream), and the local archive's raw/ and media/ trees into archive/python/
# (the API prefixes every archive key with "<app>/" now).
# Run with inversa-api and inversa-litestream stopped. Idempotent: a second run moves nothing.
# Refuses to clobber: when any old path and its new path both exist, it exits 1 before moving.
# Usage: migrate-app-dirs.sh [DATA_DIR]   (default $INVERSA_DATA_DIR, then /var/lib/inversa)
set -euo pipefail

DIR="${1:-${INVERSA_DATA_DIR:-/var/lib/inversa}}"
APP=python
[ -d "$DIR" ] || { echo "migrate-app-dirs: $DIR is not a directory" >&2; exit 1; }

# old path (relative to $DIR) -> new path (relative to $DIR)
pairs=()
for db in observations team; do
  for f in "$db.db" "$db.db-wal" "$db.db-shm" ".$db.db-litestream"; do
    pairs+=("$f" "$APP/$f")
  done
done
for sub in raw media; do
  pairs+=("archive/$sub" "archive/$APP/$sub")
done

# Pass 1: find work and conflicts; touch nothing.
todo=()
conflicts=0
for ((i = 0; i < ${#pairs[@]}; i += 2)); do
  src="${pairs[i]}" dst="${pairs[i + 1]}"
  [ -e "$DIR/$src" ] || [ -L "$DIR/$src" ] || continue
  if [ -e "$DIR/$dst" ] || [ -L "$DIR/$dst" ]; then
    echo "migrate-app-dirs: both $DIR/$src and $DIR/$dst exist; refusing to clobber" >&2
    conflicts=$((conflicts + 1))
  else
    todo+=("$src" "$dst")
  fi
done
if [ "$conflicts" -gt 0 ]; then
  echo "migrate-app-dirs: $conflicts conflict(s); nothing moved. Resolve by hand." >&2
  exit 1
fi
if [ "${#todo[@]}" -eq 0 ]; then
  echo "migrate-app-dirs: $DIR already in per-app layout; nothing to do"
  exit 0
fi

# Pass 2: move. Same filesystem, so each mv is a rename.
for ((i = 0; i < ${#todo[@]}; i += 2)); do
  src="${todo[i]}" dst="${todo[i + 1]}"
  mkdir -p "$(dirname "$DIR/$dst")"
  mv "$DIR/$src" "$DIR/$dst"
  echo "migrate-app-dirs: moved $src -> $dst"
done
echo "migrate-app-dirs: done ($((${#todo[@]} / 2)) path(s) moved into $DIR/$APP)"
