#!/usr/bin/env bash
# Encrypted MongoDB + uploads backup.
#   Required env: MONGODB_URI, BACKUP_DIR, AGE_RECIPIENT (public key from `age-keygen`)
#   Optional: UPLOAD_DIR, RETENTION_DAYS (default 30), RCLONE_REMOTE (e.g. b2:nie-backups),
#             HEALTHCHECK_URL (pinged on success; /fail on failure)
# The age *private* key must NOT be stored on this server.
set -Eeuo pipefail
umask 077

: "${MONGODB_URI:?}" "${BACKUP_DIR:?}" "${AGE_RECIPIENT:?}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/$STAMP"
mkdir -p "$OUT"

fail() {
  echo "backup FAILED: $*" >&2
  [[ -n "${HEALTHCHECK_URL:-}" ]] && curl -fsS -m 10 "$HEALTHCHECK_URL/fail" >/dev/null || true
  exit 1
}
trap 'fail "line $LINENO"' ERR

# --oplog gives a point-in-time consistent dump but requires a full-instance dump (URI without
# a database name). Set BACKUP_OPLOG=1 with such a URI; otherwise the named database is dumped.
OPLOG_ARGS=()
[[ "${BACKUP_OPLOG:-0}" == "1" ]] && OPLOG_ARGS=(--oplog)
mongodump --uri="$MONGODB_URI" --archive --gzip ${OPLOG_ARGS[@]+"${OPLOG_ARGS[@]}"} | age -r "$AGE_RECIPIENT" -o "$OUT/mongo.archive.gz.age"
if [[ -n "${UPLOAD_DIR:-}" && -d "$UPLOAD_DIR" ]]; then
  tar -C "$UPLOAD_DIR" -czf - . | age -r "$AGE_RECIPIENT" -o "$OUT/uploads.tar.gz.age"
fi
( cd "$OUT" && sha256sum ./*.age > SHA256SUMS )
[[ -s "$OUT/mongo.archive.gz.age" ]] || fail "empty database archive"

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  rclone copy "$OUT" "$RCLONE_REMOTE/$STAMP" --immutable
fi
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} +

[[ -n "${HEALTHCHECK_URL:-}" ]] && curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null || true
echo "backup OK: $OUT"
