#!/usr/bin/env bash
set -euo pipefail

KUBO_API="${KUBO_API:-http://kubo:5001}"
REMOTE="${RCLONE_REMOTE:?RCLONE_REMOTE is required}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_ROOT="${BACKUP_WORK_ROOT:-/backups}"
WORK="$WORK_ROOT/snapshot-$STAMP"
mkdir -p "$WORK/cars"

curl --fail --silent --show-error --request POST "$KUBO_API/api/v0/id" | jq -r '.ID' > "$WORK/peer-id.txt"
curl --fail --silent --show-error --request POST "$KUBO_API/api/v0/pin/ls?type=recursive&enc=json" \
  | jq -r '.Keys | keys[]' | LC_ALL=C sort -u > "$WORK/pins.txt"

while IFS= read -r cid; do
  [[ "$cid" =~ ^[A-Za-z0-9]+$ ]] || { echo "Unsafe CID in pinset" >&2; exit 1; }
  tmp="$WORK/cars/$cid.car.part"
  curl --fail --silent --show-error --request POST \
    "$KUBO_API/api/v0/dag/export?arg=$cid" --output "$tmp"
  test -s "$tmp"
  mv "$tmp" "$WORK/cars/$cid.car"
done < "$WORK/pins.txt"

(cd "$WORK" && find cars -type f -name '*.car' -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum > sha256sums.txt)
jq -n --arg version "1" --arg createdAt "$STAMP" --arg peerId "$(cat "$WORK/peer-id.txt")" \
  --argjson roots "$(jq -Rsc 'split("\n") | map(select(length > 0))' < "$WORK/pins.txt")" \
  '{version:($version|tonumber),createdAt:$createdAt,peerId:$peerId,roots:$roots}' > "$WORK/manifest.json"

rclone copy "$WORK" "$REMOTE/snapshots/$STAMP" --checksum --immutable --create-empty-src-dirs
rclone copyto "$WORK/manifest.json" "$REMOTE/latest.json" --checksum

if [[ "${RETENTION_DAYS:-0}" =~ ^[0-9]+$ ]] && (( RETENTION_DAYS > 0 )); then
  rclone delete "$REMOTE/snapshots" --min-age "${RETENTION_DAYS}d" || echo "Warning: retention cleanup could not delete every expired object" >&2
  rclone rmdirs "$REMOTE/snapshots" --leave-root || echo "Warning: retention cleanup could not remove every empty directory" >&2
fi

echo "Backup completed: $REMOTE/snapshots/$STAMP"
