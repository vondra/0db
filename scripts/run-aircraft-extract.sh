#!/usr/bin/env bash
# Aircraft pipeline v6 driver — wrapper around the `aircraft-extract`
# binary that runs Stage 0..2C end-to-end against the ADS-B TAR cache
# and writes per-R4 popup arrows (airborne / cruise / ground) under
# `data/prepared/{DATA_YEAR}/h3r4/<R4>/`.
#
# Stage 0/1 are per-day; Stage 2A/2B/2C aggregate the full window.
# `aircraft-extract run-all` orchestrates the cross-day flow.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

DATA_YEAR="${DATA_YEAR:-2025}"
DATA_ROOT="${DATA_ROOT:-data}"
ADSB_CACHE="${ADSB_CACHE:-$DATA_ROOT/source/adsb-cache}"
H3R4_DIR="${H3R4_DIR:-$DATA_ROOT/prepared/$DATA_YEAR/h3r4}"
PREPARED_DIR="${PREPARED_DIR:-$DATA_ROOT/prepared}"
WORK_DIR="${WORK_DIR:-/tmp/aircraft-extract-work}"
DAYS="${DAYS:-}"

log() { echo "[aircraft-extract] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

if [ -z "$DAYS" ]; then
    log "DAYS env var not set; deriving from ADSB_CACHE=$ADSB_CACHE"
    if [ ! -d "$ADSB_CACHE" ]; then
        log "ERROR: $ADSB_CACHE not found and DAYS not provided"
        exit 1
    fi
    DAYS="$(find "$ADSB_CACHE" -maxdepth 2 -name '*.tar' -printf '%f\n' \
        | sed 's/\.tar$//' | sort -u | paste -sd,)"
fi
[ -z "$DAYS" ] && { log "ERROR: no days resolved"; exit 1; }

log "rebuilding aircraft-extract (release)"
cargo build --release --manifest-path engine/aircraft-extract/Cargo.toml --bin aircraft-extract

mkdir -p "$WORK_DIR" "$H3R4_DIR"

log "running aircraft-extract run-all (DAYS=$DAYS)"
./engine/aircraft-extract/target/release/aircraft-extract run-all \
    --adsb-cache "$ADSB_CACHE" \
    --h3r4-dir "$H3R4_DIR" \
    --prepared-dir "$PREPARED_DIR" \
    --work-dir "$WORK_DIR" \
    --days "$DAYS"

log "done — popup arrows in $H3R4_DIR/<R4>/{airborne,cruise,ground}.arrow"
