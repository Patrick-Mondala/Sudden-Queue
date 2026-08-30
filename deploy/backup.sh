#!/usr/bin/env bash
#
# Nightly database dump.
#
#   sudo cp deploy/backup.sh /usr/local/bin/sudden-queue-backup
#   sudo chmod +x /usr/local/bin/sudden-queue-backup
#   sudo crontab -e
#     17 4 * * *  /usr/local/bin/sudden-queue-backup >> /var/log/sudden-queue-backup.log 2>&1
#
# Your host's own backup is a snapshot of the disk, taken while Postgres is
# running and kept for a day. That will usually restore, and "usually" is doing
# a lot of work: a bad migration noticed on Tuesday is already past a Monday
# snapshot. This is the copy that answers for that.
#
# The ladder and match history are the product. They are not reconstructable
# from anywhere else, because nothing but this database ever saw the results.
set -euo pipefail

DEST="${SQ_BACKUP_DIR:-/var/backups/sudden-queue}"
KEEP_DAYS="${SQ_BACKUP_KEEP_DAYS:-14}"
DB_NAME="${SQ_DB_NAME:-suddenqueue}"
DB_USER="${SQ_DB_USER:-suddenqueue}"

mkdir -p "$DEST"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DEST/${DB_NAME}-${STAMP}.sql.gz"

# --clean --if-exists so the dump can be restored over an existing database
# without hand-editing it first, which is exactly the moment you least want to
# be hand-editing anything.
# SQ_IN_DOCKER=1 reaches the database inside the compose stack. Unset, it
# expects a pg_dump on this machine talking to a local Postgres.
if [ -n "${SQ_IN_DOCKER:-}" ]; then
	COMPOSE="${SQ_COMPOSE_FILE:-/srv/sudden-queue/compose.prod.yaml}"
	DUMP=(docker compose -f "$COMPOSE" exec -T postgres pg_dump)
else
	DUMP=(pg_dump)
fi

"${DUMP[@]}" \
	--username="$DB_USER" \
	--dbname="$DB_NAME" \
	--no-owner \
	--clean \
	--if-exists \
	| gzip -9 > "$FILE.partial"

# Rename only once the dump completed. A half-written file with the right name
# is worse than no file, because it looks like a backup.
mv "$FILE.partial" "$FILE"

SIZE="$(du -h "$FILE" | cut -f1)"
echo "$(date -u +%FT%TZ) wrote $FILE ($SIZE)"

# A dump that restores nothing still writes a file. Refuse to call an
# implausibly small one a backup.
MIN_BYTES="${SQ_BACKUP_MIN_BYTES:-1024}"
if [ "$(stat -c %s "$FILE")" -lt "$MIN_BYTES" ]; then
	echo "$(date -u +%FT%TZ) WARNING: $FILE is under ${MIN_BYTES} bytes; check the database" >&2
	exit 1
fi

DELETED="$(find "$DEST" -name "${DB_NAME}-*.sql.gz" -mtime "+${KEEP_DAYS}" -print -delete | wc -l)"
echo "$(date -u +%FT%TZ) pruned $DELETED older than ${KEEP_DAYS} days"

# Copy it off this machine.
#
# Backups that live only on the server they came from do not survive the thing
# most likely to destroy the server. OVH lost a datacentre to fire in 2021 and
# customers with only provider-side copies lost data. Uncomment one:
#
#   rclone copy "$FILE" remote:sudden-queue-backups/
#   aws s3 cp "$FILE" s3://your-bucket/sudden-queue/
#   scp "$FILE" you@elsewhere:/backups/
