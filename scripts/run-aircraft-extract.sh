#!/usr/bin/env bash
# Aircraft pipeline driver — wrapper around the `aircraft-extract`
# binary that runs Stage 0..2C end-to-end against the ADS-B TAR cache
# and writes per-R4 popup arrows (airborne / cruise / ground) under
# `data/prepared/{DATA_YEAR}/h3r4/<R4>/`.
#
# Stage 0/1 are per-day; Stage 2A/2B/2C aggregate the full window.
# `aircraft-extract run-all` orchestrates the cross-day flow.
#
# Stage reuse — to iterate on a single later stage without re-running
# upstream work, pass `--from-stage <stage>` (or set
# `FROM_STAGE=<stage>`). Valid values: stage0 (default — full
# pipeline), stage1, shuffle, stage1-5, stage2a, stage2b, stage2c.
# Each variant reuses outputs that an earlier `run-all` left under
# WORK_DIR (`flights/`, `segments/`, `segments_by_r4/`). Example:
# `./scripts/run-aircraft-extract.sh --from-stage stage2a` reuses the
# cached Stage 1 segments and per-R4 shuffle, runs only Stage 2A/2B/2C.
# See `aircraft-extract run-all --help` for per-variant requirements.
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
# REQUIRED for bbox/radius subset caches (Canary, Praha-150km, ...) —
# full daily traces of in-scope flights would otherwise overwrite
# global R4 files. The aircraft-extract binary hard-fails when
# --adsb-cache contains /bbox/ or /radius/ AND --scope-bbox is unset.
#
# Default tracks the default ADSB_CACHE (Praha 150 km radius around
# 50.10°N 14.43°E): a bounding box that covers the entire 150 km
# disc with ~10 km margin. Override when ADSB_CACHE is changed.
SCOPE_BBOX="${SCOPE_BBOX:-48.65,12.00,51.55,16.90}"
FROM_STAGE="${FROM_STAGE:-}"

log() { echo "[aircraft-extract] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
die() { log "ERROR: $*"; exit 1; }

# CLI args are accepted as the discoverable alternative to env vars.
# Only the stage-reuse flag is parsed here — every other knob remains
# env-var-driven to keep the surface small (DAYS, ADSB_CACHE, … rarely
# change per invocation, --from-stage flips between runs).
while [ $# -gt 0 ]; do
    case "$1" in
        --from-stage)
            [ $# -ge 2 ] || die "--from-stage requires a value"
            FROM_STAGE="$2"
            shift 2
            ;;
        --from-stage=*)
            FROM_STAGE="${1#*=}"
            shift
            ;;
        -h|--help)
            # Pipe the header comment block (between the shebang and
            # the first non-comment line) so `--help` and the source
            # docs stay one source of truth.
            awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"
            echo
            echo "Usage: $0 [--from-stage <stage0|stage1|shuffle|stage1-5|stage2a|stage2b|stage2c>]"
            echo "Env vars: DATA_YEAR, DATA_ROOT, ADSB_CACHE, H3R4_DIR, PREPARED_DIR, WORK_DIR,"
            echo "          DAYS, SCOPE_BBOX, FROM_STAGE, LOG_DIR"
            exit 0
            ;;
        *)
            die "unknown argument: $1 (try --help)"
            ;;
    esac
done

if [ -z "$DAYS" ]; then
    log "DAYS env var not set; deriving from ADSB_CACHE=$ADSB_CACHE"
    [ -d "$ADSB_CACHE" ] || die "$ADSB_CACHE not found and DAYS not provided"
    # AdsbTarSource accepts both `<root>/<year>/<day>/subset.tar` and
    # the flat `<root>/<day>/subset.tar` (subset caches). Walk to the
    # parent dir of each *.tar so the day is the basename of
    # `dirname tarfile`.
    DAYS="$(find "$ADSB_CACHE" -mindepth 1 -maxdepth 4 -name '*.tar' -printf '%h\n' \
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
    2>&1 | stdbuf -oL -eL tee -a "$LOG_FILE"

mkdir -p "$WORK_DIR" "$H3R4_DIR"

log "running aircraft-extract run-all (DAYS=$DAYS)"
# `tee` instead of a `tail` filter: streams every per-day milestone +
# Stage 2B/2C 10-second progress tick straight into the log file AND
# stdout (so `bash run_in_background` output and a foreground terminal
# both see live progress). `tail -F logs/aircraft-extract-latest.log`
# is the operator's go-to during multi-hour global runs.
EXTRA_ARGS=()
if [ -n "$SCOPE_BBOX" ]; then
    EXTRA_ARGS+=(--scope-bbox "$SCOPE_BBOX")
    log "scope bbox: $SCOPE_BBOX"
fi
if [ -n "$FROM_STAGE" ]; then
    EXTRA_ARGS+=(--from-stage "$FROM_STAGE")
    log "from-stage: $FROM_STAGE (skipping every phase before $FROM_STAGE)"
fi
./engine/aircraft-extract/target/release/aircraft-extract run-all \
    --adsb-cache "$ADSB_CACHE" \
    --h3r4-dir "$H3R4_DIR" \
    --prepared-dir "$PREPARED_DIR" \
    --work-dir "$WORK_DIR" \
    --days "$DAYS" \
    "${EXTRA_ARGS[@]}" \
    2>&1 | stdbuf -oL -eL tee -a "$LOG_FILE"

log "done — popup arrows in $H3R4_DIR/<R4>/{airborne,cruise,airport_traffic}.arrow"
