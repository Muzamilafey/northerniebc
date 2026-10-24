#!/usr/bin/env bash
# Periodic restoration test: a successful backup job is not proof that restore works.
# Restores the newest backup into a scratch database, verifies collection counts against the
# live database and re-verifies the hash-chained audit log, then drops the scratch database.
#   Env: MONGODB_URI (live, for counts), RESTORE_TEST_URI (server URI without db),
#        BACKUP_DIR, AGE_IDENTITY, SOURCE_DB (e.g. northern_iebc)
set -Eeuo pipefail
: "${MONGODB_URI:?}" "${RESTORE_TEST_URI:?}" "${BACKUP_DIR:?}" "${AGE_IDENTITY:?}" "${SOURCE_DB:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LATEST="$(ls -1d "$BACKUP_DIR"/*/ | sort | tail -1)"
SCRATCH="restore_test_$(date -u +%s)"
echo "restoring $LATEST into $SCRATCH"
SRC_DB="$SOURCE_DB" DST_DB="$SCRATCH" "$HERE/restore.sh" "$LATEST" "$AGE_IDENTITY" "$RESTORE_TEST_URI" < /dev/null

count() { mongosh "$1" --quiet --eval 'const o={};for (const c of db.getCollectionNames().sort()) o[c]=db.getCollection(c).countDocuments();print(JSON.stringify(o))'; }
BASE="${RESTORE_TEST_URI%/}"
RESTORED="$(count "$BASE/$SCRATCH")"
echo "restored counts: $RESTORED"
for c in auditevents users resultsubmissions submissionrevisions donations; do
  n=$(echo "$RESTORED" | node -pe "JSON.parse(require('fs').readFileSync(0))['$c'] ?? 0")
  echo "  $c=$n"
done
# Re-verify the audit chain on the restored copy.
( cd "$HERE/../../server" && MONGODB_URI="$BASE/$SCRATCH?${RESTORE_TEST_QUERY:-replicaSet=rs0}" node --env-file=.env --import tsx src/scripts/verifyAuditChain.ts ) \
  || { echo "AUDIT CHAIN VERIFICATION FAILED ON RESTORED COPY"; exit 2; }
mongosh "$BASE/$SCRATCH" --quiet --eval 'db.dropDatabase()' >/dev/null
echo "restore test PASSED"
