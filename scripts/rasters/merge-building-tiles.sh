#!/usr/bin/env bash
# Copy Overture 30m building height rasters to prepared/rasters/building/.
#
# Overture rasters are produced by download-overture-buildings.sh.
# No GHSL fallback — where Overture has no building polygon, height = 0.
#
# Usage:
#   ./scripts/rasters/merge-building-tiles.sh                    # all tiles
#   ./scripts/rasters/merge-building-tiles.sh --prefix N49E016   # single tile
set -euo pipefail
cd "$(dirname "$0")/../.."

BUILDING_DIR="data/prepared/rasters/building"
OVERTURE_DIR="data/enrichment/global/overture-buildings/rasterized"
EXPECTED_SIZE=12967201  # 3601 * 3601
PREFIX="${2:-}"

log() { echo "[merge-bld] $(date '+%H:%M:%S') $*"; }

if [ ! -d "$OVERTURE_DIR" ]; then
    log "ERROR: Overture rasterized dir not found: $OVERTURE_DIR"
    log "  Run download-overture-buildings.sh first."
    exit 1
fi

mkdir -p "$BUILDING_DIR"

# Build tile list
TILES=$(ls "$OVERTURE_DIR"/*.raw 2>/dev/null | sed 's/.*\///; s/\.raw//')
if [ -n "${1:-}" ] && [ "${1:-}" = "--prefix" ] && [ -n "$PREFIX" ]; then
    TILES=$(echo "$TILES" | grep "^${PREFIX}" || true)
fi

TOTAL=$(echo "$TILES" | grep -c . || echo 0)
if [ "$TOTAL" -eq 0 ]; then
    log "No Overture tiles to copy"
    exit 0
fi

log "Copying $TOTAL Overture tiles to $BUILDING_DIR"
COPIED=0
SKIPPED=0

for NAME in $TILES; do
    SRC="$OVERTURE_DIR/${NAME}.raw"
    DST="$BUILDING_DIR/${NAME}.raw"
    SRC_SZ=$(stat --format=%s "$SRC" 2>/dev/null || echo 0)

    if [ "$SRC_SZ" -ne "$EXPECTED_SIZE" ]; then
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Skip if destination already matches
    DST_SZ=$(stat --format=%s "$DST" 2>/dev/null || echo 0)
    if [ "$DST_SZ" -eq "$EXPECTED_SIZE" ]; then
        SRC_MOD=$(stat --format=%Y "$SRC")
        DST_MOD=$(stat --format=%Y "$DST")
        if [ "$DST_MOD" -ge "$SRC_MOD" ]; then
            SKIPPED=$((SKIPPED + 1))
            continue
        fi
    fi

    cp "$SRC" "$DST"
    COPIED=$((COPIED + 1))
done

log "Done: copied=$COPIED, skipped=$SKIPPED, total=$TOTAL"
