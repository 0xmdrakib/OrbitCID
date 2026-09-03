#!/usr/bin/env bash
set -euo pipefail

KUBO_API="${KUBO_API:-http://kubo:5001}"
REMOTE="${RCLONE_REMOTE:?RCLONE_REMOTE is required}"
WORK_ROOT="${BACKUP_WORK_ROOT:-/backups}"
SNAPSHOT="${1:-}"
if [[ -z "$SNAPSHOT" ]]; then
  SNAPSHOT="$(rclone lsf "$REMOTE/snapshots" --dirs-only | sed 's:/$::' | LC_ALL=C sort | tail -n 1)"
fi
[[ "$SNAPSHOT" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "A valid snapshot timestamp is required" >&2; exit 1; }

WORK="$WORK_ROOT/restore-$SNAPSHOT"
rm -rf "$WORK"
mkdir -p "$WORK"
rclone copy "$REMOTE/snapshots/$SNAPSHOT" "$WORK" --checksum

(cd "$WORK" && sha256sum --check sha256sums.txt)
jq -e '.version == 1 and (.roots | type == "array")' "$WORK/manifest.json" >/dev/null

while IFS= read -r cid; do
  [[ "$cid" =~ ^[A-Za-z0-9]+$ ]] || { echo "Unsafe CID in manifest" >&2; exit 1; }
  car="$WORK/cars/$cid.car"
  test -s "$car"
  output="$(curl --fail --silent --show-error --request POST \
    --form "file=@$car;type=application/vnd.ipld.car" \
    "$KUBO_API/api/v0/dag/import?pin-roots=true&allow-big-block=true")"
  grep -Fq "$cid" <<< "$output"
  curl --fail --silent --show-error --request POST "$KUBO_API/api/v0/pin/add?recursive=true&arg=$cid" >/dev/null
done < "$WORK/pins.txt"

echo "Restore completed from: $REMOTE/snapshots/$SNAPSHOT"
