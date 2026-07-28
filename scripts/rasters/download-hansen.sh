#!/usr/bin/env bash
# Download Hansen Global Forest Change v1.12 (2000–2024) granules for the
# rest-of-world continuous forest density source (geodata-v2 2a): the
# treecover2000 percentage + lossyear masks, 10°×10° GeoTIFFs from the
# public GCS bucket (no auth). EU uses HRL TCD 2023 instead; Hansen covers
# everywhere else, so we fetch the whole grid and let the converter prefer
# TCD where present. ~504 land granules × 2 layers, ~100–140 GB.
#
#   scripts/rasters/download-hansen.sh [--jobs 3]
#
# Resumable: a granule whose local size matches the remote Content-Length is
# skipped; partial files continue via curl -C -. Layout:
#   data/source/hansen/GFC-2024-v1.12/{treecover2000,lossyear}/<granule>.tif
set -euo pipefail
cd "$(dirname "$0")/../.."

BASE="https://storage.googleapis.com/earthenginepartners-hansen/GFC-2024-v1.12"
DEST="data/source/hansen/GFC-2024-v1.12"
JOBS=3
[ "${1:-}" = "--jobs" ] && JOBS="$2"

mkdir -p "$DEST/treecover2000" "$DEST/lossyear"

# The published grid: top-left corners, lat 80N..50S step 10 (granule spans
# 10° down), lon 180W..170E step 10. Ocean-only granules 404 → skipped.
granules() {
    for lat in 80N 70N 60N 50N 40N 30N 20N 10N 00N 10S 20S 30S 40S 50S; do
        for lon_i in $(seq -180 10 170); do
            if [ "$lon_i" -lt 0 ]; then
                printf '%s_%03dW\n' "$lat" "$((-lon_i))"
            else
                printf '%s_%03dE\n' "$lat" "$lon_i"
            fi
        done
    done
}

fetch_one() {
    local layer="$1" gran="$2"
    local name="Hansen_GFC-2024-v1.12_${layer}_${gran}.tif"
    local url="$BASE/$name" out="$DEST/$layer/$name"
    local remote
    remote=$(curl -sI --max-time 30 "$url" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}' | tail -1)
    if [ -z "$remote" ]; then
        echo "[hansen] $gran $layer: no granule (ocean) — skip"
        return 0
    fi
    if [ -f "$out" ] && [ "$(stat -c%s "$out")" = "$remote" ]; then
        return 0
    fi
    echo "[hansen] $gran $layer ($((remote / 1000000)) MB)"
    curl -sS -C - --max-time 3600 --retry 5 --retry-delay 30 -o "$out" "$url"
    if [ "$(stat -c%s "$out")" != "$remote" ]; then
        echo "[hansen] SIZE MISMATCH $out ($(stat -c%s "$out") vs $remote)" >&2
        return 1
    fi
}

export -f fetch_one
export BASE DEST

fail=0
for layer in treecover2000 lossyear; do
    granules | xargs -P "$JOBS" -I{} bash -c 'fetch_one "$0" "$1"' "$layer" {} || fail=1
done

n_tc=$(ls "$DEST/treecover2000" | wc -l)
n_ly=$(ls "$DEST/lossyear" | wc -l)
echo "[hansen] finished: treecover2000=$n_tc lossyear=$n_ly granules (fail=$fail)"
exit "$fail"
