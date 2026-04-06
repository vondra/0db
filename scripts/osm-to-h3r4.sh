#!/usr/bin/env bash
# Extract noise-relevant features from OSM planet PBF → H3R4 Arrow IPC.
#
# Output: data/prepared/2026/h3r4/{hex}/ with roads.arrow, railways.arrow, buildings.arrow, industrial.arrow
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

YEAR="${DATA_YEAR:-2025}"
PBF_FILE="data/source/osm/${YEAR}/planet-latest.osm.pbf"
OUTPUT_DIR="data/prepared/${YEAR}/h3r4"
NODE_CACHE="/tmp/osm_nodes.cache"
SPILL_DIR="/tmp/osm_spill"
BINARY="engine/osm-extract/target/release/osm-to-h3r4"

log() { echo "[osm] $(date '+%H:%M:%S') $*"; }

if [ ! -f "$BINARY" ]; then
    log "ERROR: Binary not found: $BINARY"
    exit 1
fi

if [ ! -f "$PBF_FILE" ]; then
    log "ERROR: Planet PBF not found: $PBF_FILE"
    exit 1
fi

PBF_SIZE=$(stat --printf='%s' "$PBF_FILE")
PBF_SIZE_HR=$(numfmt --to=iec-i --suffix=B "$PBF_SIZE")

log "=== OSM extraction ==="
log "  Input:      $PBF_FILE ($PBF_SIZE_HR)"
log "  Output:     $OUTPUT_DIR"
log "  Node cache: $NODE_CACHE"
log "  Spill dir:  $SPILL_DIR"
log "  Disk free:  $(df -h "$HOME" --output=avail | tail -1 | xargs)"

mkdir -p "$OUTPUT_DIR"

T_START=$(date +%s)

# Background monitor: report progress every 2 min
(
    while true; do
        sleep 120
        NOW=$(date +%s)
        ELAPSED=$((NOW - T_START))
        ELAPSED_HR=$(printf '%dh%02dm' $((ELAPSED/3600)) $(((ELAPSED%3600)/60)))
        HEX_COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 -type d 2>/dev/null | wc -l)
        CACHE_SIZE=0
        [ -f "$NODE_CACHE" ] && CACHE_SIZE=$(stat --printf='%s' "$NODE_CACHE" 2>/dev/null || echo 0)
        CACHE_HR=$(numfmt --to=iec-i --suffix=B "$CACHE_SIZE" 2>/dev/null || echo "?")
        DISK_FREE=$(df -h "$HOME" --output=avail | tail -1 | xargs)
        log "  progress: $ELAPSED_HR | hexes $HEX_COUNT | node-cache $CACHE_HR | disk $DISK_FREE"
    done
) &
MONITOR_PID=$!

"$BINARY" \
    --input "$PBF_FILE" \
    --output "$OUTPUT_DIR" \
    --node-cache "$NODE_CACHE" \
    --spill-dir "$SPILL_DIR" \
    2>&1 | while IFS= read -r line; do log "  $line"; done

kill "$MONITOR_PID" 2>/dev/null || true
wait "$MONITOR_PID" 2>/dev/null || true

T_ELAPSED=$(( $(date +%s) - T_START ))
HEX_COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 -type d 2>/dev/null | wc -l)
OUTPUT_SIZE=$(du -sh "$OUTPUT_DIR" 2>/dev/null | cut -f1)

log ""
log "Cleaning up node cache ..."
rm -f "$NODE_CACHE"

log ""
log "=== OSM extraction DONE ==="
log "  $HEX_COUNT hex directories, $OUTPUT_SIZE total"
log "  Time: $(printf '%dh%02dm%02ds' $((T_ELAPSED/3600)) $(((T_ELAPSED%3600)/60)) $((T_ELAPSED%60)))"
log "  Disk free: $(df -h "$HOME" --output=avail | tail -1 | xargs)"
