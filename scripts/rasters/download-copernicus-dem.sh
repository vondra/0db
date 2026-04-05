#!/usr/bin/env bash
# Download Copernicus GLO-30 DEM from AWS S3 (public, no auth).
# ~1.26 TB, 4-8h depending on bandwidth.
set -euo pipefail
cd "$(dirname "$0")/../.."

DST="data/source/dem/copernicus-glo30"
mkdir -p "$DST"

echo "[cop-dem] $(date '+%H:%M:%S') Downloading Copernicus GLO-30 from s3://copernicus-dem-30m/ ..."
echo "[cop-dem] $(date '+%H:%M:%S') Destination: $DST"
echo "[cop-dem] $(date '+%H:%M:%S') Disk free: $(df -h "$HOME" --output=avail | tail -1 | xargs)"

aws s3 sync s3://copernicus-dem-30m/ "$DST/" --no-sign-request --quiet

SIZE=$(du -sh "$DST" | cut -f1)
COUNT=$(ls "$DST" | wc -l)
echo "[cop-dem] $(date '+%H:%M:%S') Done: $COUNT directories, $SIZE"
