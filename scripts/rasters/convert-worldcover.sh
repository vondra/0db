#!/usr/bin/env bash
# Convert ESA WorldCover 2021 → forest .raw + IMD proxy .raw for ALL land tiles.
# Each 3°×3° WorldCover tile produces up to 9 output 1°×1° tiles.
# ~50 min with 16 parallel.
set -euo pipefail
cd "$(dirname "$0")/../.."

WC_SRC="data/source/vegetation/worldcover-2021"
FOREST_DST="data/prepared/rasters/forest"
IMD_DST="data/prepared/rasters/imd"
JOBS="${JOBS:-16}"

mkdir -p "$FOREST_DST" "$IMD_DST"

# Build global VRT once
VRT="/tmp/worldcover_global.vrt"
if [ ! -f "$VRT" ]; then
    echo "[worldcover] $(date '+%H:%M:%S') Building global VRT from $(ls "$WC_SRC"/*.tif | wc -l) tiles..."
    gdalbuildvrt -q "$VRT" "$WC_SRC"/*.tif
    echo "[worldcover] $(date '+%H:%M:%S') VRT ready"
fi

# Generate list of all 1°×1° tiles to produce.
# Parse WorldCover tile names (e.g., ESA_WorldCover_10m_2021_v200_N48E012_Map.tif)
# Each covers 3°×3°, so N48E012 → produces tiles for lat 48-50, lon 12-14
TILE_LIST="/tmp/worldcover_tiles.txt"
python3 -c "
import os, re
tiles = set()
for f in os.listdir('$WC_SRC'):
    m = re.match(r'ESA_WorldCover_10m_2021_v200_([NS])(\d+)([EW])(\d+)_Map\.tif', f)
    if not m: continue
    lat = int(m.group(2)) * (1 if m.group(1) == 'N' else -1)
    lon = int(m.group(4)) * (1 if m.group(3) == 'E' else -1)
    for dlat in range(3):
        for dlon in range(3):
            t_lat = lat + dlat
            t_lon = lon + dlon
            ns = 'N' if t_lat >= 0 else 'S'
            ew = 'E' if t_lon >= 0 else 'W'
            name = f'{ns}{abs(t_lat):02d}{ew}{abs(t_lon):03d}'
            tiles.add(name)
for t in sorted(tiles):
    print(t)
" > "$TILE_LIST"

TOTAL=$(wc -l < "$TILE_LIST")
echo "[worldcover] $(date '+%H:%M:%S') $TOTAL unique 1°×1° tiles to produce ($JOBS parallel)"

# Conversion function per tile
convert_one() {
    local NAME="$1"
    local FOREST_OUT="$FOREST_DST/${NAME}.raw"
    local IMD_OUT="$IMD_DST/${NAME}.raw"

    # Skip if both exist
    [ -f "$FOREST_OUT" ] && [ -f "$IMD_OUT" ] && return 0

    # Parse lat/lon from name
    local ns=${NAME:0:1}
    local lat=${NAME:1:2}
    local ew=${NAME:3:1}
    local lon=${NAME:4:3}
    # Remove leading zeros for arithmetic
    lat=$((10#$lat))
    lon=$((10#$lon))
    [ "$ns" = "S" ] && lat=$((-lat))
    [ "$ew" = "W" ] && lon=$((-lon))

    local TMP_FOREST="/tmp/wc_forest_${NAME}.tif"
    local TMP_IMD="/tmp/wc_imd_${NAME}.tif"

    # Warp for forest (1201×1201)
    if [ ! -f "$FOREST_OUT" ]; then
        gdalwarp -q -te "$lon" "$lat" "$((lon + 1))" "$((lat + 1))" \
            -ts 1201 1201 -r near -ot Byte \
            "$VRT" "$TMP_FOREST" 2>/dev/null || { rm -f "$TMP_FOREST"; return 0; }
    fi

    # Warp for IMD (401×401)
    if [ ! -f "$IMD_OUT" ]; then
        gdalwarp -q -te "$lon" "$lat" "$((lon + 1))" "$((lat + 1))" \
            -ts 401 401 -r near -ot Byte \
            "$VRT" "$TMP_IMD" 2>/dev/null || { rm -f "$TMP_IMD"; return 0; }
    fi

    # Reclassify with Python
    python3 -c "
import numpy as np
from osgeo import gdal
gdal.UseExceptions()

# Forest: class 10 (tree cover) → 100, else → 0
if not __import__('os').path.exists('$FOREST_OUT'):
    ds = gdal.Open('$TMP_FOREST')
    if ds:
        arr = ds.GetRasterBand(1).ReadAsArray()
        np.where(arr == 10, np.uint8(100), np.uint8(0)).tofile('$FOREST_OUT')
        ds = None

# IMD proxy: WorldCover class → imperviousness %
if not __import__('os').path.exists('$IMD_OUT'):
    ds = gdal.Open('$TMP_IMD')
    if ds:
        arr = ds.GetRasterBand(1).ReadAsArray()
        lut = np.zeros(256, dtype=np.uint8)
        lut[10] = 2    # tree cover
        lut[20] = 5    # shrubland
        lut[30] = 5    # grassland
        lut[40] = 10   # cropland
        lut[50] = 85   # built-up
        lut[60] = 15   # bare/sparse
        lut[70] = 0    # snow/ice
        lut[80] = 0    # water
        lut[90] = 5    # wetland
        lut[95] = 2    # mangroves
        lut[100] = 5   # moss/lichen
        lut[arr.flat].reshape(arr.shape).tofile('$IMD_OUT')
        ds = None
" 2>/dev/null

    rm -f "$TMP_FOREST" "$TMP_IMD"
}
export -f convert_one
export VRT FOREST_DST IMD_DST

# Run parallel
cat "$TILE_LIST" | xargs -P "$JOBS" -I{} bash -c 'convert_one "$@"' _ {}

FOREST_DONE=$(ls "$FOREST_DST"/*.raw 2>/dev/null | wc -l)
IMD_DONE=$(ls "$IMD_DST"/*.raw 2>/dev/null | wc -l)
FOREST_SIZE=$(du -sh "$FOREST_DST" 2>/dev/null | cut -f1)
IMD_SIZE=$(du -sh "$IMD_DST" 2>/dev/null | cut -f1)
echo "[worldcover] $(date '+%H:%M:%S') Done: forest=$FOREST_DONE tiles ($FOREST_SIZE), imd=$IMD_DONE tiles ($IMD_SIZE)"
rm -f "$VRT" "$TILE_LIST"
