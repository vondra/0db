#!/usr/bin/env bash
# Convert Copernicus GLO-30 COG tiles → .hgt (i16 BE).
# Copernicus tiles are already 1°×1° WGS84 COGs — just format conversion.
# ~30 min with 16 parallel.
set -euo pipefail
cd "$(dirname "$0")/../.."

SRC="data/source/dem/copernicus-glo30"
DST="data/prepared/dem/copernicus"
JOBS="${JOBS:-16}"

mkdir -p "$DST"

# Copernicus tiles are in subdirs: Copernicus_DSM_COG_10_N49_00_E016_00_DEM/
# Each contains a *_DEM.tif file
TILE_LIST="/tmp/copernicus_dem_tiles.txt"
find "$SRC" -name "*_DEM.tif" -not -name "*_EDM*" > "$TILE_LIST"
TOTAL=$(wc -l < "$TILE_LIST")

echo "[cop-dem] $(date '+%H:%M:%S') Converting $TOTAL Copernicus COG → .hgt ($JOBS parallel)"

convert_one() {
    local tif="$1"
    # Extract tile name from path: Copernicus_DSM_COG_10_N49_00_E016_00_DEM → N49E016
    local dir
    dir=$(basename "$(dirname "$tif")")
    local name
    name=$(echo "$dir" | sed -E 's/Copernicus_DSM_COG_[0-9]+_([NS])([0-9]+)_00_([EW])([0-9]+)_00_DEM/\1\2\3\4/')
    # Pad to standard naming: N49E016
    local ns=${name:0:1}
    local lat=${name:1}
    lat=$(echo "$lat" | sed -E 's/([0-9]+)([EW].*)/\1/')
    local rest=$(echo "$name" | sed -E 's/^[NS][0-9]+//')
    local ew=${rest:0:1}
    local lon=${rest:1}
    local out_name
    out_name=$(printf "%s%02d%s%03d" "$ns" "$((10#$lat))" "$ew" "$((10#$lon))")
    local out="$DST/${out_name}.hgt"
    [ -f "$out" ] && return 0
    gdal_translate -of SRTMHGT -q "$tif" "$out" 2>/dev/null || true
}
export -f convert_one
export DST

cat "$TILE_LIST" | xargs -P "$JOBS" -I{} bash -c 'convert_one "$@"' _ {}

DONE=$(find "$DST" -name "*.hgt" | wc -l)
SIZE=$(du -sh "$DST" 2>/dev/null | cut -f1)
echo "[cop-dem] $(date '+%H:%M:%S') Done: $DONE .hgt tiles, $SIZE"
rm -f "$TILE_LIST"
