#!/usr/bin/env bash
# Extract noise-relevant features from OSM planet PBF → H3R4 Arrow IPC.
#
# Output: data/prepared/{year}/h3r4/{hex}/ with roads.arrow, railways.arrow, buildings.arrow, industrial.arrow
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

YEAR="${DATA_YEAR:-2026}"  # active dataset year (.env DATA_YEAR=2026)
DATA_ROOT="${DATA_ROOT:-$PROJECT_DIR/data}"
RUN_SERVICE_TREE="${RUN_SERVICE_TREE:-1}"
STAMP_ROAD_METADATA="${STAMP_ROAD_METADATA:-1}"
if [[ -d /mnt/data ]]; then
    DEFAULT_SCRATCH_ROOT="/mnt/data/tmp/quietmap"
else
    DEFAULT_SCRATCH_ROOT="/tmp/quietmap"
fi
SCRATCH_ROOT="${SCRATCH_ROOT:-$DEFAULT_SCRATCH_ROOT}"
PBF_FILE="${PBF_FILE:-$DATA_ROOT/source/osm/${YEAR}/planet-latest.osm.pbf}"
OUTPUT_DIR="${OUTPUT_DIR:-$DATA_ROOT/prepared/${YEAR}/h3r4}"
NODE_CACHE="${NODE_CACHE:-$SCRATCH_ROOT/osm_nodes.cache}"
SPILL_DIR="${SPILL_DIR:-$SCRATCH_ROOT/osm_spill}"
BINARY="engine/osm-extract/target/release/osm-to-h3r4"
ROAD_ARROW_UPGRADE_BIN="engine/source-reader/target/release/road-arrow-upgrade"

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

mkdir -p "$OUTPUT_DIR" "$(dirname "$NODE_CACHE")" "$SPILL_DIR"

log "=== OSM extraction ==="
log "  Input:      $PBF_FILE ($PBF_SIZE_HR)"
log "  Output:     $OUTPUT_DIR"
log "  Scratch:    $SCRATCH_ROOT"
log "  Node cache: $NODE_CACHE"
log "  Spill dir:  $SPILL_DIR"
log "  Disk free:  output $(df -h "$OUTPUT_DIR" --output=avail | tail -1 | xargs) | scratch $(df -h "$SCRATCH_ROOT" --output=avail | tail -1 | xargs)"

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
        DISK_FREE_OUTPUT=$(df -h "$OUTPUT_DIR" --output=avail | tail -1 | xargs)
        DISK_FREE_SCRATCH=$(df -h "$SCRATCH_ROOT" --output=avail | tail -1 | xargs)
        log "  progress: $ELAPSED_HR | hexes $HEX_COUNT | node-cache $CACHE_HR | output $DISK_FREE_OUTPUT | scratch $DISK_FREE_SCRATCH"
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

if [ "$RUN_SERVICE_TREE" = "1" ]; then
    if [ ! -d "$PROJECT_DIR/pipeline/node_modules" ]; then
        log ""
        log "Installing pipeline dependencies ..."
        npm --prefix "$PROJECT_DIR/pipeline" ci \
            2>&1 | while IFS= read -r line; do log "  $line"; done
    fi

    log ""
    log "Running service-tree road enrichment ..."
    (
        cd "$PROJECT_DIR/pipeline"
        DATA_YEAR="$YEAR" npx tsx enrich-roads-service-tree.ts
    ) 2>&1 | while IFS= read -r line; do log "  $line"; done

    if [ "$STAMP_ROAD_METADATA" = "1" ]; then
        if [ ! -f "$ROAD_ARROW_UPGRADE_BIN" ]; then
            log ""
            log "Building road-arrow-upgrade ..."
            cargo build --release --manifest-path engine/source-reader/Cargo.toml --bin road-arrow-upgrade \
                2>&1 | while IFS= read -r line; do log "  $line"; done
        fi

        log ""
        log "Stamping road Arrow provenance ..."
        "$ROAD_ARROW_UPGRADE_BIN" "$OUTPUT_DIR" \
            2>&1 | while IFS= read -r line; do log "  $line"; done
    fi
fi

log ""
log "Building H3R4 → admin lookup table (data/prepared/h3r4-admin.bin) ..."
(
    cd "$SCRIPT_DIR"
    if [ ! -d node_modules ]; then
        npm ci 2>&1 | while IFS= read -r line; do log "    $line"; done
    fi
    DATA_YEAR="$YEAR" npm run build:h3-admin
) 2>&1 | while IFS= read -r line; do log "  $line"; done

log ""
log "=== OSM extraction DONE ==="
log "  $HEX_COUNT hex directories, $OUTPUT_SIZE total"
log "  Time: $(printf '%dh%02dm%02ds' $((T_ELAPSED/3600)) $(((T_ELAPSED%3600)/60)) $((T_ELAPSED%60)))"
log "  Disk free: output $(df -h "$OUTPUT_DIR" --output=avail | tail -1 | xargs) | scratch $(df -h "$SCRATCH_ROOT" --output=avail | tail -1 | xargs)"
