#!/usr/bin/env bash
# Merge Overture 30m building heights with GHSL fallback.
# For each tile: upsample GHSL 1201→3601, overlay Overture where > 0, write merged.
#
# This REPLACES existing .raw tiles in data/prepared/rasters/building/ with
# 3601x3601 (30m) tiles. Tiles without Overture data keep their original GHSL size.
#
# Prerequisite: run download-overture-buildings.sh first.
#
# Usage:
#   ./scripts/rasters/merge-building-tiles.sh                    # all tiles
#   ./scripts/rasters/merge-building-tiles.sh --prefix N49E016   # single tile
#   JOBS=8 ./scripts/rasters/merge-building-tiles.sh             # custom parallelism
set -euo pipefail
cd "$(dirname "$0")/../.."

BUILDING_DIR="data/prepared/rasters/building"
OVERTURE_DIR="data/enrichment/global/overture-buildings/rasterized"
BACKUP_DIR="data/enrichment/global/overture-buildings/ghsl-backup"
JOBS="${JOBS:-16}"
PREFIX="${2:-}"
GHSL_SIZE=1442401        # 1201 * 1201
MERGED_SIZE=12967201     # 3601 * 3601

log() { echo "[merge-bld] $(date '+%H:%M:%S') $*"; }

# ── Argument parsing ────────────────────────────────────────────────────
if [ "${1:-}" = "--prefix" ] && [ -n "$PREFIX" ]; then
    FILTER_PREFIX="$PREFIX"
else
    FILTER_PREFIX=""
fi

# ── Dependency check ────────────────────────────────────────────────────
if ! python3 -c "import numpy" &>/dev/null; then
    log "ERROR: python3 numpy not found."
    exit 1
fi

if [ ! -d "$OVERTURE_DIR" ]; then
    log "ERROR: Overture rasterized dir not found: $OVERTURE_DIR"
    log "  Run download-overture-buildings.sh first."
    exit 1
fi

mkdir -p "$BACKUP_DIR"

# ── Build tile list: only tiles that have Overture rasters ──────────────
TILE_LIST="/tmp/merge_bld_tiles.txt"
ls "$OVERTURE_DIR"/*.raw 2>/dev/null | sed 's/.*\///; s/\.raw//' | sort > "$TILE_LIST"

if [ -n "$FILTER_PREFIX" ]; then
    grep "^${FILTER_PREFIX}" "$TILE_LIST" > "${TILE_LIST}.filtered" || true
    mv "${TILE_LIST}.filtered" "$TILE_LIST"
fi

TOTAL=$(wc -l < "$TILE_LIST")
if [ "$TOTAL" -eq 0 ]; then
    log "No Overture tiles to merge"
    rm -f "$TILE_LIST"
    exit 0
fi

log "Merging $TOTAL tiles ($JOBS parallel)"
log "  GHSL source: $BUILDING_DIR"
log "  Overture source: $OVERTURE_DIR"
log "  GHSL backups: $BACKUP_DIR"

# ── Counter for progress ────────────────────────────────────────────────
PROGRESS_FILE="/tmp/merge_bld_progress"
echo 0 > "$PROGRESS_FILE"

merge_tile() {
    local NAME="$1"
    local GHSL="$BUILDING_DIR/${NAME}.raw"
    local OVERTURE="$OVERTURE_DIR/${NAME}.raw"
    local BACKUP="$BACKUP_DIR/${NAME}.raw"
    local OUT="$BUILDING_DIR/${NAME}.raw"

    # Check Overture raster exists and is 3601x3601
    if [ ! -f "$OVERTURE" ]; then
        return 0
    fi
    local OV_SZ
    OV_SZ=$(stat --format=%s "$OVERTURE" 2>/dev/null || echo 0)
    if [ "$OV_SZ" -ne "$MERGED_SIZE" ]; then
        return 0
    fi

    # If output already merged (3601x3601), skip
    if [ -f "$OUT" ]; then
        local OUT_SZ
        OUT_SZ=$(stat --format=%s "$OUT" 2>/dev/null || echo 0)
        if [ "$OUT_SZ" -eq "$MERGED_SIZE" ]; then
            local C
            C=$(cat "$PROGRESS_FILE")
            echo $((C + 1)) > "$PROGRESS_FILE"
            return 0
        fi
    fi

    # Back up original GHSL (only if not already backed up)
    if [ -f "$GHSL" ] && [ ! -f "$BACKUP" ]; then
        cp "$GHSL" "$BACKUP"
    fi

    # Merge: upsample GHSL + overlay Overture
    python3 -c "
import numpy as np

# Load Overture (3601x3601)
ov = np.fromfile('$OVERTURE', dtype=np.uint8).reshape(3601, 3601)

# Load and upsample GHSL
ghsl_path = '$BACKUP' if '$BACKUP' != '' else '$GHSL'
import os
if os.path.exists('$BACKUP'):
    ghsl_path = '$BACKUP'
elif os.path.exists('$GHSL'):
    ghsl_path = '$GHSL'
else:
    # No GHSL fallback — just use Overture
    ov.tofile('$OUT')
    raise SystemExit(0)

ghsl_raw = np.fromfile(ghsl_path, dtype=np.uint8)
sz = ghsl_raw.size

if sz == $MERGED_SIZE:
    # Already 3601x3601 (e.g. from prior merge)
    ghsl = ghsl_raw.reshape(3601, 3601)
elif sz == $GHSL_SIZE:
    # Upsample 1201x1201 → 3601x3601 (nearest neighbor via repeat)
    ghsl = ghsl_raw.reshape(1201, 1201)
    ghsl = np.repeat(np.repeat(ghsl, 3, axis=0), 3, axis=1)[:3601, :3601]
else:
    # Unknown size — try reshape as square, then resize
    side = int(np.sqrt(sz))
    if side * side == sz:
        ghsl = ghsl_raw.reshape(side, side)
        # Simple nearest-neighbor resize
        rows = np.linspace(0, side - 1, 3601).astype(int)
        cols = np.linspace(0, side - 1, 3601).astype(int)
        ghsl = ghsl[np.ix_(rows, cols)]
    else:
        # Cannot interpret — use Overture only
        ov.tofile('$OUT')
        raise SystemExit(0)

# Overture only — no GHSL fallback (GHSL has false positives on highways/fields)
merged = np.clip(ov, 0, 249).astype(np.uint8)
merged.tofile('$OUT')
" 2>/dev/null

    # Verify output
    local FINAL_SZ
    FINAL_SZ=$(stat --format=%s "$OUT" 2>/dev/null || echo 0)
    if [ "$FINAL_SZ" -ne "$MERGED_SIZE" ]; then
        # Restore backup on failure
        if [ -f "$BACKUP" ]; then
            cp "$BACKUP" "$OUT"
        fi
        echo "[merge-bld] WARNING: Failed to merge $NAME, restored GHSL" >&2
    fi

    # Progress
    local C
    C=$(cat "$PROGRESS_FILE")
    C=$((C + 1))
    echo "$C" > "$PROGRESS_FILE"
    if (( C % 100 == 0 )); then
        echo "[merge-bld] $(date '+%H:%M:%S') Progress: $C / $TOTAL tiles"
    fi
}
export -f merge_tile
export BUILDING_DIR OVERTURE_DIR BACKUP_DIR MERGED_SIZE GHSL_SIZE TOTAL PROGRESS_FILE

cat "$TILE_LIST" | xargs -P "$JOBS" -I{} bash -c 'merge_tile "$@"' _ {}

# ── Summary ─────────────────────────────────────────────────────────────
MERGED_COUNT=0
TOTAL_TILES=0
for f in "$BUILDING_DIR"/*.raw; do
    [ -f "$f" ] || continue
    TOTAL_TILES=$((TOTAL_TILES + 1))
    SZ=$(stat --format=%s "$f" 2>/dev/null || echo 0)
    [ "$SZ" -eq "$MERGED_SIZE" ] && MERGED_COUNT=$((MERGED_COUNT + 1))
done

log "Done: $MERGED_COUNT/$TOTAL_TILES building tiles upgraded to 30m"
log "  GHSL backups: $(ls "$BACKUP_DIR"/*.raw 2>/dev/null | wc -l) tiles ($(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1))"
log "  Building dir size: $(du -sh "$BUILDING_DIR" 2>/dev/null | cut -f1)"
rm -f "$TILE_LIST" "$PROGRESS_FILE"
