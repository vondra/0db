#!/usr/bin/env bash
# Incremental world obstacle ingest (geodata-v2 1.1 world): watch the Overture
# parquet cache and run `ingest-overture-obstacles.py` on every tile exactly
# once, while the world download is still streaming in — per-tile ingest is
# independent by the centroid half-open ownership contract (see the ingest
# header), so staging pipelines behind the download instead of waiting ~a day
# for it to finish.
#
#   scripts/obstacles/ingest-world-incremental.sh [--jobs 6]
#
# Resume-safe: ingested tiles are recorded in .ingested-tiles; a re-run skips
# them (the ingest's own stale-shard reconcile guards double-runs anyway).
# Exits when the downloader has finished AND every cached parquet is ingested.
set -euo pipefail
cd "$(dirname "$0")/../.."

PARQUET_DIR="data/enrichment/global/overture-buildings/parquet"
STATE="data/enrichment/global/overture-obstacles/.ingested-tiles"
JOBS=6
[ "${1:-}" = "--jobs" ] && JOBS="$2"

mkdir -p "$(dirname "$STATE")"
touch "$STATE"

ingest_one() {
    local tile="$1"
    if nice -n 10 python3 scripts/obstacles/ingest-overture-obstacles.py "$tile" \
        >> data/enrichment/global/overture-obstacles/.ingest-runs.log 2>&1; then
        echo "$tile" >> "$STATE"
        echo "[world-ingest] $tile ok"
    else
        echo "[world-ingest] $tile FAILED (left out of state; next pass retries)" >&2
        return 1
    fi
}
export -f ingest_one
export STATE

while true; do
    ls "$PARQUET_DIR"/*.parquet 2>/dev/null | sed 's/.*\///; s/\.parquet$//' | sort > /tmp/world-ingest-have.txt
    sort "$STATE" > /tmp/world-ingest-done.txt
    comm -23 /tmp/world-ingest-have.txt /tmp/world-ingest-done.txt > /tmp/world-ingest-todo.txt
    todo=$(wc -l < /tmp/world-ingest-todo.txt)
    if [ "$todo" -gt 0 ]; then
        echo "[world-ingest] $(date '+%H:%M') ingesting $todo new tiles ($(wc -l < /tmp/world-ingest-done.txt) done)"
        xargs -P "$JOBS" -I{} bash -c 'ingest_one "$1"' _ {} < /tmp/world-ingest-todo.txt || true
    fi
    if ! pgrep -f "download-overture-world" > /dev/null && [ "$todo" -eq 0 ]; then
        echo "[world-ingest] downloader gone and nothing left — finished: $(wc -l < "$STATE") tiles ingested"
        break
    fi
    sleep 300
done
