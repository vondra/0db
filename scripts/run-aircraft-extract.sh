#!/usr/bin/env bash
# Aircraft pipeline driver — wrapper around the `aircraft-extract`
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
ADSB_CACHE="${ADSB_CACHE:-$DATA_ROOT/source/flights-cache/radius/praha-150km}"
H3R4_DIR="${H3R4_DIR:-$DATA_ROOT/prepared/$DATA_YEAR/h3r4}"
PREPARED_DIR="${PREPARED_DIR:-$DATA_ROOT/prepared}"
WORK_DIR="${WORK_DIR:-/tmp/aircraft-extract-work}"
DAYS="${DAYS:-}"

log() { echo "[aircraft-extract] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
die() { log "ERROR: $*"; exit 1; }

if [ -z "$DAYS" ]; then
    log "DAYS env var not set; deriving from ADSB_CACHE=$ADSB_CACHE"
    [ -d "$ADSB_CACHE" ] || die "$ADSB_CACHE not found and DAYS not provided"
    # Layout matches AdsbTarSource: <root>/<year>/<day>/subset.tar
    # (depth 3). Walk to the parent dir of each *.tar so the day is
    # the basename of `dirname tarfile`.
    DAYS="$(find "$ADSB_CACHE" -mindepth 2 -maxdepth 4 -name '*.tar' -printf '%h\n' \
        | awk -F/ '{print $NF}' | sort -u | paste -sd,)"
fi
[ -n "$DAYS" ] || die "no ADS-B TAR days resolved from $ADSB_CACHE"

LOG_DIR="${LOG_DIR:-logs}"
LOG_FILE="$LOG_DIR/aircraft-extract-$(date '+%Y%m%d-%H%M%S').log"
mkdir -p "$LOG_DIR"
ln -sf "$(basename "$LOG_FILE")" "$LOG_DIR/aircraft-extract-latest.log"
log "logging to $LOG_FILE (symlinked $LOG_DIR/aircraft-extract-latest.log)"

log "rebuilding aircraft-extract (release)"
cargo build --release --manifest-path engine/aircraft-extract/Cargo.toml --bin aircraft-extract \
    2>&1 | tee -a "$LOG_FILE"

mkdir -p "$WORK_DIR" "$H3R4_DIR"

log "running aircraft-extract run-all (DAYS=$DAYS)"
# `tee` instead of a `tail` filter: streams every per-day milestone +
# Stage 2B/2C 10-second progress tick straight into the log file AND
# stdout (so `bash run_in_background` output and a foreground terminal
# both see live progress). `tail -F logs/aircraft-extract-latest.log`
# is the operator's go-to during multi-hour global runs.
./engine/aircraft-extract/target/release/aircraft-extract run-all \
    --adsb-cache "$ADSB_CACHE" \
    --h3r4-dir "$H3R4_DIR" \
    --prepared-dir "$PREPARED_DIR" \
    --work-dir "$WORK_DIR" \
    --days "$DAYS" \
    2>&1 | tee -a "$LOG_FILE"

log "done — popup arrows in $H3R4_DIR/<R4>/{airborne,cruise,ground}.arrow"
