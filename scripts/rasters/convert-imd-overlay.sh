#!/usr/bin/env bash
# Overlay Copernicus IMD (Europe, continuous 0-100%) over WorldCover-derived IMD proxy.
# Overwrites existing .raw tiles where Copernicus data is available.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/rasters/node-extent.sh

IMD_DST="data/prepared/rasters/imd"

# Find all available Copernicus IMD source files
IMD_SOURCES=()
# Ascending years: gdalbuildvrt paints later files over earlier, so the
# newest release wins where coverage overlaps (2024 = EU-wide HRL VLCC,
# geodata-v2 2b; 2018/2021 remain as the CZ-era fallback).
for f in data/source/imd/2018/*.tif data/source/imd/2021/*.tif data/source/imd/2024/*.tif; do
    [ -f "$f" ] && IMD_SOURCES+=("$f")
done

if [ ${#IMD_SOURCES[@]} -eq 0 ]; then
    echo "[imd-overlay] No Copernicus IMD source files found. Skipping."
    exit 0
fi

echo "[imd-overlay] $(date '+%H:%M:%S') Overlaying ${#IMD_SOURCES[@]} Copernicus IMD file(s)"

# Build VRT if multiple sources
if [ ${#IMD_SOURCES[@]} -eq 1 ]; then
    SRC="${IMD_SOURCES[0]}"
else
    SRC="/tmp/imd_copernicus.vrt"
    gdalbuildvrt -q "$SRC" "${IMD_SOURCES[@]}"
fi

# Get extent of source data. MUST come from wgs84Extent, not cornerCoordinates:
# corners are in the source SRS — for the EPSG:3857 CZ source they are metres
# (lat "6830000"), and feeding those to the seq loops below means ~5×10^11
# iterations = a silent permanent hang (/gg Gemini 2026-06-11, verified).
EXTENT=$(gdalinfo "$SRC" -json 2>/dev/null | python3 -c "
import sys, json, math
info = json.load(sys.stdin)
ring = info.get('wgs84Extent', {}).get('coordinates', [[]])[0]
if not ring:
    sys.exit('no wgs84Extent in gdalinfo output — cannot derive tile range')
lats = [p[1] for p in ring]
lons = [p[0] for p in ring]
print(f'{math.floor(min(lats))} {math.floor(max(lats))} '
      f'{math.floor(min(lons))} {math.floor(max(lons))}')
")
read LAT_MIN LAT_MAX LON_MIN LON_MAX <<< "$EXTENT"
echo "[imd-overlay] $(date '+%H:%M:%S') Extent: lat $LAT_MIN..$LAT_MAX, lon $LON_MIN..$LON_MAX"

COUNT=0
FAILED=0
for lat in $(seq "$LAT_MIN" "$LAT_MAX"); do
    for lon in $(seq "$LON_MIN" "$LON_MAX"); do
        ns="N"; [ "$lat" -lt 0 ] && ns="S"
        ew="E"; [ "$lon" -lt 0 ] && ew="W"
        NAME=$(printf "%s%02d%s%03d" "$ns" "${lat#-}" "$ew" "${lon#-}")
        DST="$IMD_DST/${NAME}.raw"

        TMP="/tmp/imd_overlay_${NAME}.tif"
        rm -f "$TMP"   # leftover from an interrupted run makes gdalwarp fail
        gdalwarp -q -t_srs EPSG:4326 \
            -te $(node_extent $lon $lat 3601) \
            -ts 3601 3601 -r bilinear -ot Byte \
            "$SRC" "$TMP" 2>/dev/null || continue

        # tmp + os.replace: live popup readers must never see a torn tile
        python3 -c "
import numpy as np, os
from osgeo import gdal
gdal.UseExceptions()
ds = gdal.Open('$TMP')
arr = ds.GetRasterBand(1).ReadAsArray()
arr = np.clip(arr, 0, 100).astype(np.uint8)
if np.any(arr > 0):
    # Copernicus HRL maps water as 0% impervious -> G=1 soft, re-breaking the
    # ISO water=hard fix. In the WorldCover-derived base, exactly value 100 is
    # water (built-up is 85) -- preserve it where Copernicus says 0.
    if os.path.exists('$DST'):
        base = np.fromfile('$DST', dtype=np.uint8).reshape(arr.shape)
        arr = np.where((arr == 0) & (base == 100), np.uint8(100), arr)
    tmp = '$DST.tmp.' + str(os.getpid())
    arr.tofile(tmp)
    os.replace(tmp, '$DST')
ds = None
" || { FAILED=$((FAILED + 1)); echo "[imd-overlay] WARN: ${NAME} reclassify failed" >&2; }
        rm -f "$TMP"
        COUNT=$((COUNT + 1))
    done
done

echo "[imd-overlay] $(date '+%H:%M:%S') Done: $COUNT tiles overwritten with Copernicus IMD"
if [ "$FAILED" -gt 0 ]; then
    echo "[imd-overlay] ERROR: $FAILED tile(s) failed to reclassify" >&2
    exit 1
fi
