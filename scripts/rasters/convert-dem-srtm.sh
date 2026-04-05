#!/usr/bin/env bash
# Convert ALL SRTM v3 GeoTIFF → .hgt (i16 BE, 3601×3601)
# Pure format conversion, no reprojection. ~30 min with 16 parallel.
set -euo pipefail
cd "$(dirname "$0")/../.."

SRC="data/source/dem/srtm-v3/SRTM_GL1_srtm"
DST="data/prepared/dem/srtm"
JOBS="${JOBS:-16}"

mkdir -p "$DST"

TOTAL=$(ls "$SRC"/*.tif 2>/dev/null | wc -l)
echo "[dem-srtm] $(date '+%H:%M:%S') Converting $TOTAL SRTM tiles → .hgt ($JOBS parallel)"

convert_one() {
    local tif="$1"
    local name
    name=$(basename "$tif" .tif)
    local out="$DST/${name}.hgt"
    [ -f "$out" ] && return 0
    gdal_translate -of SRTMHGT -q "$tif" "$out" 2>/dev/null || true
}
export -f convert_one
export DST

ls "$SRC"/*.tif | xargs -P "$JOBS" -I{} bash -c 'convert_one "$@"' _ {}

DONE=$(ls "$DST"/*.hgt 2>/dev/null | wc -l)
SIZE=$(du -sh "$DST" 2>/dev/null | cut -f1)
echo "[dem-srtm] $(date '+%H:%M:%S') Done: $DONE .hgt tiles, $SIZE"
