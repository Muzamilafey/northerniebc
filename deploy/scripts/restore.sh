#!/usr/bin/env bash
# Restores an encrypted backup produced by backup.sh.
#   restore.sh <backup-dir> <age-identity-file> <target-mongodb-uri> [--drop] [--uploads <dir>]
# Restoring into production requires --drop and an explicit confirmation prompt.
set -Eeuo pipefail
SRC="${1:?backup dir}"; KEY="${2:?age identity file}"; TARGET="${3:?target uri}"; shift 3
DROP=""; UPLOADS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --drop) DROP="--drop" ;;
    --uploads) UPLOADS="$2"; shift ;;
  esac
  shift
done
( cd "$SRC" && sha256sum -c SHA256SUMS )
if [[ -n "$DROP" && -t 0 ]]; then
  read -r -p "This will DROP and replace collections in $TARGET. Type RESTORE to continue: " ok
  [[ "$ok" == "RESTORE" ]] || exit 1
fi
# Set RESTORE_OPLOG_REPLAY=1 for archives taken with BACKUP_OPLOG=1.
# NS mapping lets the archive be restored into a differently named database (e.g. restore tests).
SRC_DB="${SRC_DB:-}"; DST_DB="${DST_DB:-}"
NS_ARGS=()
if [[ -n "$SRC_DB" && -n "$DST_DB" ]]; then NS_ARGS=(--nsFrom="$SRC_DB.*" --nsTo="$DST_DB.*"); fi
age -d -i "$KEY" "$SRC/mongo.archive.gz.age" | mongorestore --uri="$TARGET" --archive --gzip $DROP ${NS_ARGS[@]+"${NS_ARGS[@]}"} ${RESTORE_OPLOG_REPLAY:+--oplogReplay}
if [[ -n "$UPLOADS" && -f "$SRC/uploads.tar.gz.age" ]]; then
  mkdir -p "$UPLOADS"
  age -d -i "$KEY" "$SRC/uploads.tar.gz.age" | tar -C "$UPLOADS" -xzf -
fi
echo "restore OK into $TARGET"
