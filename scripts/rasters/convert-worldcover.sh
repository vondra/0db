#!/usr/bin/env bash
# Convert ESA WorldCover 2021 → forest .raw + IMD proxy .raw for ALL land tiles.
# Each 3°×3° WorldCover tile produces up to 9 output 1°×1° tiles.
# ~50 min with 16 parallel.
#
# --imd-force  regenerate IMD outputs even when they already exist (atomic
#              in-place overwrite via tmp+rename — the old tile stays readable
#              until the replace). Needed when the class→imperviousness LUT
#              changes (e.g. the 2026-06 water 0→100 fix): without it the
#              exists-skip makes a re-run a silent no-op (/gg W1). Forest
#              outputs are never touched — forest derives from class 10 alone.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/rasters/node-extent.sh

IMD_FORCE=0
for arg in "$@"; do
    case "$arg" in
        --imd-force) IMD_FORCE=1 ;;
        *) echo "usage: $0 [--imd-force]" >&2; exit 1 ;;
    esac
done

WC_SRC="data/source/vegetation/worldcover-2021"
FOREST_DST="data/prepared/rasters/forest"
IMD_DST="data/prepared/rasters/imd"
JOBS="${JOBS:-16}"

mkdir -p "$FOREST_DST" "$IMD_DST"

# Build global VRT once. tmp+mv so an interrupted build can never leave a
# partial VRT that a later (reusing) run silently mosaics from — a partial
# VRT is the 1-px-nodata-stripe hazard (/gg 2026-06-11).
VRT="/tmp/worldcover_global.vrt"
if [ ! -f "$VRT" ]; then
    echo "[worldcover] $(date '+%H:%M:%S') Building global VRT from $(find "$WC_SRC" -maxdepth 1 -name '*.tif' | wc -l) tiles..."
    gdalbuildvrt -q "$VRT.tmp" "$WC_SRC"/*.tif && mv "$VRT.tmp" "$VRT"
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

    # --imd-force regenerates IMD bytes (LUT change); the stale tile is NOT
    # deleted up front — it stays readable until the atomic replace below,
    # because live popup readers default a missing IMD tile to hard ground
    # and cache the miss (/gg 2026-06-11 CRITICAL). Forest never forced —
    # it derives from class 10 alone.
    local NEED_FOREST=0 NEED_IMD=0
    [ -f "$FOREST_OUT" ] || NEED_FOREST=1
    if [ ! -f "$IMD_OUT" ] || [ "${IMD_FORCE:-0}" = "1" ]; then NEED_IMD=1; fi
    [ "$NEED_FOREST" = "0" ] && [ "$NEED_IMD" = "0" ] && return 0

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
    # Leftovers from an interrupted run make gdalwarp fail ("output exists")
    rm -f "$TMP_FOREST" "$TMP_IMD"

    # Warp for forest (3601×3601 = 30m, node-registered matching DEM)
    if [ "$NEED_FOREST" = "1" ]; then
        gdalwarp -q -te $(node_extent $lon $lat 3601) \
            -ts 3601 3601 -r near -ot Byte \
            "$VRT" "$TMP_FOREST" 2>/dev/null \
            || { rm -f "$TMP_FOREST"; echo "$NAME warp-forest" >> "$FAIL_LIST"; return 0; }
    fi

    # Warp for IMD (3601×3601 = 30m, node-registered matching DEM/forest/building)
    if [ "$NEED_IMD" = "1" ]; then
        gdalwarp -q -te $(node_extent $lon $lat 3601) \
            -ts 3601 3601 -r near -ot Byte \
            "$VRT" "$TMP_IMD" 2>/dev/null \
            || { rm -f "$TMP_IMD"; echo "$NAME warp-imd" >> "$FAIL_LIST"; return 0; }
    fi

    # Reclassify with Python. Outputs land via tmp + os.replace so a reader
    # (popup mmap) never sees a torn tile and an interrupted run never leaves
    # a partial .raw that the exists-skip would treat as done (/gg 2026-06-11).
    python3 -c "
import numpy as np, os
from osgeo import gdal
gdal.UseExceptions()

def write_atomic(arr, dst):
    tmp = f'{dst}.tmp.{os.getpid()}'
    arr.tofile(tmp)
    os.replace(tmp, dst)

# Forest: class 10 (tree cover) → 100, else → 0
if '$NEED_FOREST' == '1':
    ds = gdal.Open('$TMP_FOREST')
    arr = ds.GetRasterBand(1).ReadAsArray()
    write_atomic(np.where(arr == 10, np.uint8(100), np.uint8(0)), '$FOREST_OUT')
    ds = None

# IMD proxy: WorldCover class → imperviousness %
if '$NEED_IMD' == '1':
    ds = gdal.Open('$TMP_IMD')
    arr = ds.GetRasterBand(1).ReadAsArray()
    lut = np.zeros(256, dtype=np.uint8)
    lut[10] = 2    # tree cover
    lut[20] = 5    # shrubland
    lut[30] = 5    # grassland
    lut[40] = 10   # cropland
    lut[50] = 85   # built-up
    lut[60] = 15   # bare/sparse
    # Snow/ice stays soft (G=1): WorldCover 70 is permanent snow/firn
    # (glaciers), and snow cover is acoustically porous. ISO 9613-2 lists
    # bare ice as hard, but bare ice is a negligible sliver of class 70.
    lut[70] = 0    # snow/ice
    # Water is acoustically HARD, G=0 (ISO 9613-2 7.3.1 groups it with
    # paving/concrete). Was 0 = fully soft, ~3 dB too quiet across
    # lakes/rivers/sea (2026-06 audit B3).
    lut[80] = 100  # water
    lut[90] = 5    # wetland
    lut[95] = 2    # mangroves
    lut[100] = 5   # moss/lichen
    write_atomic(lut[arr.flat].reshape(arr.shape), '$IMD_OUT')
    ds = None
" || echo "$NAME reclass" >> "$FAIL_LIST"

    rm -f "$TMP_FOREST" "$TMP_IMD"
}
export -f convert_one
export VRT FOREST_DST IMD_DST IMD_FORCE

# Per-tile failures land here; any entry fails the whole run at the end —
# a silent gap would otherwise surface as a phantom hard/soft ground strip.
FAIL_LIST=$(mktemp /tmp/worldcover_failed.XXXXXX)
export FAIL_LIST

# Run parallel
cat "$TILE_LIST" | xargs -P "$JOBS" -I{} bash -c 'convert_one "$@"' _ {}

FOREST_DONE=$(find "$FOREST_DST" -maxdepth 1 -name '*.raw' | wc -l)
IMD_DONE=$(find "$IMD_DST" -maxdepth 1 -name '*.raw' | wc -l)
FOREST_SIZE=$(du -sh "$FOREST_DST" 2>/dev/null | cut -f1)
IMD_SIZE=$(du -sh "$IMD_DST" 2>/dev/null | cut -f1)
echo "[worldcover] $(date '+%H:%M:%S') Done: forest=$FOREST_DONE tiles ($FOREST_SIZE), imd=$IMD_DONE tiles ($IMD_SIZE)"
rm -f "$VRT" "$TILE_LIST"

if [ -s "$FAIL_LIST" ]; then
    echo "[worldcover] ERROR: $(wc -l < "$FAIL_LIST") tile(s) FAILED (kept at $FAIL_LIST):" >&2
    head -20 "$FAIL_LIST" >&2
    exit 1
fi
rm -f "$FAIL_LIST"
