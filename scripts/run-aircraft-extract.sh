#!/usr/bin/env bash
# Aircraft pipeline driver — wrapper around the `aircraft-extract`
# binary that runs Stage 0..2C end-to-end against the ADS-B TAR cache
# and writes per-R4 popup arrows (airborne / cruise / ground) under
# `data/prepared/{DATA_YEAR}/h3r4/<R4>/`.
#
# Stage 0/1 are per-day; Stage 2A/2B/2C aggregate the full window.
# `aircraft-extract run-all` orchestrates the cross-day flow. The
# orchestrator REFUSES to start when `--work-dir` already holds
# outputs (flights/, segments/, segments_by_r4/) AND `--from-stage`
# is the default `stage0` — without that guard, re-running this
# wrapper would silently overwrite hours of cached upstream work that
# the operator almost certainly meant to reuse. Pick `--from-stage
# stageX` (or set `FROM_STAGE=stageX`) for the stage whose code you
# changed, OR `rm -rf $WORK_DIR` to start fresh.
#
# Stage reuse — to iterate on a single later stage without re-running
# upstream work, pass `--from-stage <stage>` (or set
# `FROM_STAGE=<stage>`). Valid values: stage0 (default — full
# pipeline), stage1, shuffle, stage1-5, stage2a, stage2b, stage2c.
# Each variant reuses outputs that an earlier orchestrator run left
# under WORK_DIR (`flights/`, `segments/`, `segments_by_r4/`). Example:
# `./scripts/run-aircraft-extract.sh --from-stage stage2a` reuses the
# cached Stage 1 segments and per-R4 shuffle, runs only Stage 2A/2B/2C.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

DATA_YEAR="${DATA_YEAR:-2026}"  # active dataset year (.env DATA_YEAR=2026)
DATA_ROOT="${DATA_ROOT:-data}"
# Which ADS-B network to read. adsb.lol and adsbexchange ship the identical
# readsb trace_full TAR format, so --feed only picks the default cache path +
# scope and stamps provenance. ADSB_CACHE / SCOPE_BBOX (if set) win over the
# per-feed defaults resolved after arg parsing.
FEED="${FEED:-adsblol}"
ADSB_CACHE="${ADSB_CACHE-__PER_FEED__}"
H3R4_DIR="${H3R4_DIR:-$DATA_ROOT/prepared/$DATA_YEAR/h3r4}"
PREPARED_DIR="${PREPARED_DIR:-$DATA_ROOT/prepared}"
WORK_DIR="${WORK_DIR:-/tmp/aircraft-extract-work}"
DAYS="${DAYS:-}"
# REQUIRED for bbox/radius subset caches (Canary, Praha-150km, ...) —
# full daily traces of in-scope flights would otherwise overwrite
# global R4 files. The aircraft-extract binary hard-fails when
# --adsb-cache contains /bbox/ or /radius/ AND --scope-bbox is unset.
#
# Resolved per --feed below (Praha disc for adsb.lol; empty = global for
# adsbexchange). An explicit SCOPE_BBOX env (even empty) wins.
SCOPE_BBOX="${SCOPE_BBOX-__PER_FEED__}"
FROM_STAGE="${FROM_STAGE:-}"
# OOM guard. Stage 2B/2C load multi-million-segment mega-hub R4s; an
# unbounded run peaked at 126 GB and triggered a GLOBAL oom-kill that
# took down the whole session (2026-06-05). systemd-run --scope confines
# the blast radius to MemoryMax so only THIS job dies, never the box.
# MAX_THREADS caps rayon so N concurrent mega-hub cells can't co-resident
# past the cap. MEMMAX= (empty) opts out (e.g. no user systemd).
MEMMAX="${MEMMAX:-100G}"
MAX_THREADS="${MAX_THREADS:-}"

# Echo to stdout AND (once LOG_FILE is set) append to it, so status the
# binary doesn't emit — the OOM-guard decision above all — survives a
# `nohup …>/dev/null` launch where the script's own stdout is discarded.
log() {
    local m="[aircraft-extract] $(date '+%Y-%m-%d %H:%M:%S') $*"
    echo "$m"
    [ -n "${LOG_FILE:-}" ] && echo "$m" >>"$LOG_FILE"
    return 0
}
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
        --feed)
            [ $# -ge 2 ] || die "--feed requires a value (adsblol|adsbexchange)"
            FEED="$2"
            shift 2
            ;;
        --feed=*)
            FEED="${1#*=}"
            shift
            ;;
        -h|--help)
            # Pipe the header comment block (between the shebang and
            # the first non-comment line) so `--help` and the source
            # docs stay one source of truth.
            awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"
            echo
            echo "Usage: $0 [--feed <adsblol|adsbexchange>] [--from-stage <stage0|...|stage2c>]"
            echo "Env vars: DATA_YEAR, DATA_ROOT, FEED, ADSB_CACHE, H3R4_DIR, PREPARED_DIR, WORK_DIR,"
            echo "          DAYS, SCOPE_BBOX, FROM_STAGE, LOG_DIR"
            exit 0
            ;;
        *)
            die "unknown argument: $1 (try --help)"
            ;;
    esac
done

# Per-feed defaults — applied only where ADSB_CACHE / SCOPE_BBOX weren't set.
case "$FEED" in
    adsblol)      FEED_CACHE="$DATA_ROOT/source/flights-cache/radius/praha-150km"; FEED_SCOPE="48.65,12.00,51.55,16.90" ;;
    adsbexchange) FEED_CACHE="/storagebox/adsbexchange";                           FEED_SCOPE="" ;;
    *)            die "unknown --feed: $FEED (adsblol|adsbexchange)" ;;
esac
[ "$ADSB_CACHE" = "__PER_FEED__" ] && ADSB_CACHE="$FEED_CACHE"
[ "$SCOPE_BBOX" = "__PER_FEED__" ] && SCOPE_BBOX="$FEED_SCOPE"
log "feed: $FEED  cache=$ADSB_CACHE  scope=${SCOPE_BBOX:-<global>}"

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
EXTRA_ARGS=(--feed "$FEED")
if [ -n "$SCOPE_BBOX" ]; then
    EXTRA_ARGS+=(--scope-bbox="$SCOPE_BBOX")
    log "scope bbox: $SCOPE_BBOX"
fi
if [ -n "$FROM_STAGE" ]; then
    EXTRA_ARGS+=(--from-stage "$FROM_STAGE")
    log "from-stage: $FROM_STAGE (skipping every phase before $FROM_STAGE)"
fi
if [ -n "$MAX_THREADS" ]; then
    EXTRA_ARGS+=(--max-threads "$MAX_THREADS")
    log "max-threads: $MAX_THREADS (rayon pool cap — bounds concurrent mega-hub RAM)"
fi

# Confine RAM to MEMMAX via a transient user scope so an OOM kills only
# this job, not the box. --scope runs synchronously (foreground), so the
# `tee` pipe + live progress are unchanged. Probe first; if user systemd
# is unreachable we REFUSE to run rather than silently fall back to the
# unguarded launch that already global-OOM'd the box — set MEMMAX= to
# explicitly opt out of the guard.
GUARD=()
if [ -n "$MEMMAX" ]; then
    : "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
    GUARD=(systemd-run --user --scope --quiet -p MemoryMax="$MEMMAX" -p MemorySwapMax=0)
    # Probe with the REAL guard (incl. the -p caps) so a host that can't
    # honour MemoryMax/MemorySwapMax fails HERE, not mid-pipe.
    if ! command -v systemd-run >/dev/null 2>&1 || ! "${GUARD[@]}" true >/dev/null 2>&1; then
        die "MEMMAX=$MEMMAX set but the systemd-run --user MemoryMax guard is unavailable — refusing to run unguarded (an unbounded run global-OOM'd the whole session 2026-06-05). Re-run where user systemd is reachable, or set MEMMAX= to opt out."
    fi
    log "OOM guard: MemoryMax=$MEMMAX MemorySwapMax=0"
fi
"${GUARD[@]}" ./engine/aircraft-extract/target/release/aircraft-extract run-all \
    --adsb-cache "$ADSB_CACHE" \
    --h3r4-dir "$H3R4_DIR" \
    --prepared-dir "$PREPARED_DIR" \
    --work-dir "$WORK_DIR" \
    --days "$DAYS" \
    "${EXTRA_ARGS[@]}" \
    2>&1 | stdbuf -oL -eL tee -a "$LOG_FILE"

log "done — popup arrows in $H3R4_DIR/<R4>/{airborne,cruise,airport_traffic}.arrow"
