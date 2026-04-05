#!/usr/bin/env bash
# Overlay Copernicus IMD (Europe, continuous 0-100%) over WorldCover-derived IMD proxy.
# Overwrites existing .raw tiles where Copernicus data is available.
set -euo pipefail
cd "$(dirname "$0")/../.."

IMD_DST="data/prepared/rasters/imd"

# Find all available Copernicus IMD source files
IMD_SOURCES=()
for f in data/source/imd/2018/*.tif data/source/imd/2021/*.tif; do
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

# Get extent of source data
EXTENT=$(gdalinfo "$SRC" -json 2>/dev/null | python3 -c "
import sys, json
info = json.load(sys.stdin)
cs = info.get('cornerCoordinates', {})
ul = cs.get('upperLeft', [0,0])
lr = cs.get('lowerRight', [0,0])
import math
lat_min = int(math.floor(min(ul[1], lr[1])))
lat_max = int(math.floor(max(ul[1], lr[1])))
lon_min = int(math.floor(min(ul[0], lr[0])))
lon_max = int(math.floor(max(ul[0], lr[0])))
print(f'{lat_min} {lat_max} {lon_min} {lon_max}')
")
read LAT_MIN LAT_MAX LON_MIN LON_MAX <<< "$EXTENT"
echo "[imd-overlay] $(date '+%H:%M:%S') Extent: lat $LAT_MIN..$LAT_MAX, lon $LON_MIN..$LON_MAX"

COUNT=0
for lat in $(seq "$LAT_MIN" "$LAT_MAX"); do
    for lon in $(seq "$LON_MIN" "$LON_MAX"); do
        ns="N"; [ "$lat" -lt 0 ] && ns="S"
        ew="E"; [ "$lon" -lt 0 ] && ew="W"
        NAME=$(printf "%s%02d%s%03d" "$ns" "${lat#-}" "$ew" "${lon#-}")
        DST="$IMD_DST/${NAME}.raw"

        TMP="/tmp/imd_overlay_${NAME}.tif"
        gdalwarp -q -t_srs EPSG:4326 \
            -te "$lon" "$lat" "$((lon + 1))" "$((lat + 1))" \
            -ts 401 401 -r bilinear -ot Byte \
            "$SRC" "$TMP" 2>/dev/null || continue

        python3 -c "
import numpy as np
from osgeo import gdal
gdal.UseExceptions()
ds = gdal.Open('$TMP')
arr = ds.GetRasterBand(1).ReadAsArray()
arr = np.clip(arr, 0, 100).astype(np.uint8)
if np.any(arr > 0):
    arr.tofile('$DST')
ds = None
" 2>/dev/null
        rm -f "$TMP"
        COUNT=$((COUNT + 1))
    done
done

echo "[imd-overlay] $(date '+%H:%M:%S') Done: $COUNT tiles overwritten with Copernicus IMD"
