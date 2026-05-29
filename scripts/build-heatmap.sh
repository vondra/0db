#!/bin/bash
# build-heatmap.sh — orchestrate the whole noise heatmap: build each requested
# layer's z13 tiles + zoom pyramid (z6-12), then the precomputed `total/`
# (energy-sum of every layer, the default all-layers-on view).
#
# Each layer is its own tile tree under heatmap-v3/{layer}/ with a distinct
# HM3 source_id; `total/` is derived by build-heatmap-combine. Regenerating one
# layer = rebuild its tree + re-run combine (which re-reads the untouched
# layers). The surface kernels (road/rail/industrial/building) take a bbox or a
# single tile; the aircraft kernels additionally take --world / --shard (their
# region_runner streams the globe through a bounded LRU). So --world here means
# "aircraft world-scale"; surface layers need an explicit --bbox.
#
# Usage (the selection args are forwarded to each builder):
#   ./scripts/build-heatmap.sh --source all --bbox 49.9,14.2,50.2,14.7   # all layers, a region
#   ./scripts/build-heatmap.sh --source road --bbox <s,w,n,e>            # one surface layer + recombine
#   ./scripts/build-heatmap.sh --source all --world                      # aircraft world-scale (surface skipped)
#   ./scripts/build-heatmap.sh --combine-only                            # just rebuild total/ from existing layers
#   ./scripts/build-heatmap.sh --source road --bbox <…> --no-combine     # build a layer, skip total/
#
# Env: DATA_YEAR=2025  DATA_ROOT=data  OUTPUT=$DATA_ROOT/tiles/$DATA_YEAR/heatmap-v3  ZOOM=13
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_YEAR="${DATA_YEAR:-2025}"
DATA_ROOT="${DATA_ROOT:-data}"
H3R4="$DATA_ROOT/prepared/$DATA_YEAR/h3r4"
PREP="$DATA_ROOT/prepared"
OUTPUT="${OUTPUT:-$DATA_ROOT/tiles/$DATA_YEAR/heatmap-v3}"
ZOOM="${ZOOM:-13}"
TARGET=engine/heatmap-aircraft/target/release
SURFACE="$TARGET/build-heatmap-surface"
AIRCRAFT="$TARGET/build-heatmap-aircraft"
PYR="$TARGET/build-pyramid"
COMBINE="$TARGET/build-heatmap-combine"

log() { echo "[build-heatmap] $(date '+%H:%M:%S') $*"; }

# HM3 header source_id per layer (mirrors wire_hm3.rs SOURCE_ID_*).
declare -A SID=(
  [road]=1 [rail]=2 [industrial]=4 [building]=5
  [aircraft-airborne]=3 [aircraft-cruise]=3 [aircraft-ground]=3
)
ALL_LAYERS=(road rail industrial building aircraft-airborne aircraft-cruise aircraft-ground)

# Parse --source + combine flags; forward everything else (the selection:
# --bbox / --tile-x/--tile-y / --world / --shard) verbatim to the builders.
SOURCE=all
COMBINE_ONLY=false
NO_COMBINE=false
SEL_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:?--source needs a value}"; shift 2 ;;
    --combine-only) COMBINE_ONLY=true; shift ;;
    --no-combine) NO_COMBINE=true; shift ;;
    *) SEL_ARGS+=("$1"); shift ;;
  esac
done

case "$SOURCE" in
  all) LAYERS=("${ALL_LAYERS[@]}") ;;
  *)   LAYERS=("$SOURCE") ;;
esac

is_world=false; is_shard=false; bbox=""
for ((i = 0; i < ${#SEL_ARGS[@]}; i++)); do
  case "${SEL_ARGS[i]}" in
    --world) is_world=true ;;
    --shard) is_shard=true ;;
    --bbox)  bbox="${SEL_ARGS[i + 1]:-}" ;;
  esac
done

# Rebuild — Fastify dlopen + long jobs cache stale binaries (CLAUDE.md).
log "rebuilding (release)"
cargo build --release --manifest-path engine/heatmap-aircraft/Cargo.toml \
  --bin build-heatmap-surface --bin build-heatmap-aircraft \
  --bin build-pyramid --bin build-heatmap-combine

if ! $COMBINE_ONLY; then
  for L in "${LAYERS[@]}"; do
    LDIR="$OUTPUT/$L"
    is_surface=true; [[ "$L" == aircraft-* ]] && is_surface=false

    if $is_surface && { $is_world || $is_shard; }; then
      log "skip $L — surface kernels are bbox/tile only (use --bbox for surface)"
      continue
    fi

    # Clean the layer tree before a full (world) rebuild — only a fresh tree
    # guarantees no tile from a previous, larger run lingers (plan R4). A bbox
    # rebuild overwrites in place and the surface builder unlinks tiles that
    # rebuild all-silent, so combine never reads stale source energy either way.
    if $is_world; then
      log "clean $LDIR (full rebuild)"
      rm -rf "$LDIR"
    fi

    log "build $L → $LDIR"
    if $is_surface; then
      "$SURFACE" --source "$L" --zoom "$ZOOM" --h3r4-dir "$H3R4" \
        --prepared-dir "$PREP" --output "$LDIR" "${SEL_ARGS[@]}"
    else
      "$AIRCRAFT" --source "${L#aircraft-}" --zoom "$ZOOM" --h3r4-dir "$H3R4" \
        --prepared-dir "$PREP" --output "$LDIR" "${SEL_ARGS[@]}"
    fi

    # A sharded run owns only its z13 slice — pyramid once after rsync.
    if $is_shard; then
      log "sharded — built z$ZOOM only; pyramid $L after merging shards"
    else
      log "pyramid $L z$ZOOM → z6"
      "$PYR" --tiles-dir "$LDIR" --base-zoom "$ZOOM" --dst-zoom 6 --source-id "${SID[$L]}"
    fi
  done
fi

# Combine into total/ (skip on sharded runs — combine after the merge).
if $NO_COMBINE; then
  log "skip combine (--no-combine)"
elif $is_shard; then
  log "sharded — run combine after merging shards: $COMBINE --tiles-root $OUTPUT --zoom $ZOOM"
else
  log "combine → $OUTPUT/total"
  if [ -n "$bbox" ]; then
    "$COMBINE" --tiles-root "$OUTPUT" --zoom "$ZOOM" --bbox "$bbox"
  else
    "$COMBINE" --tiles-root "$OUTPUT" --zoom "$ZOOM"
  fi
fi
log "done → $OUTPUT"
