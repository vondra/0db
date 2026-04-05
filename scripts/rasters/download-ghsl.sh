#!/usr/bin/env bash
# Download GHSL Built-H R2023A (global building height, 100m).
# ~1.88 GB, ~5 min.
set -euo pipefail
cd "$(dirname "$0")/../.."

DST="data/source/buildings/ghsl"
ZIP="$DST/GHS_BUILT_H_ANBH_full.zip"
URL="https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_BUILT_H_GLOBE_R2023A/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100/V1-0/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100_V1_0.zip"

mkdir -p "$DST"

if [ -f "$ZIP" ]; then
    echo "[ghsl] $(date '+%H:%M:%S') Already downloaded: $ZIP ($(du -sh "$ZIP" | cut -f1))"
else
    echo "[ghsl] $(date '+%H:%M:%S') Downloading GHSL Built-H R2023A ..."
    curl -L -o "$ZIP" "$URL"
fi

echo "[ghsl] $(date '+%H:%M:%S') Extracting ..."
unzip -o -q "$ZIP" -d "$DST/"
COUNT=$(ls "$DST"/*.tif 2>/dev/null | wc -l)
echo "[ghsl] $(date '+%H:%M:%S') Done: $COUNT GeoTIFF tiles"
