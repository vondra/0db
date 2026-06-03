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
  all)    LAYERS=("${ALL_LAYERS[@]}") ;;
  ground) LAYERS=(road rail industrial building aircraft-ground) ;;   # the five shared-halo terrain layers
  *)      LAYERS=("$SOURCE") ;;
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
  # Split requested layers into the GROUND family (one shared-halo pass) and
  # aircraft (its own region_runner). Ground = road/rail/industrial/building all
  # ray-march terrain, so one 10 km halo per batch feeds every layer.
  SURFACE_LAYERS=(); AIRCRAFT_LAYERS=()
  for L in "${LAYERS[@]}"; do
    case "$L" in
      aircraft-ground) SURFACE_LAYERS+=("$L") ;;   # terrain ray-march → built by the ground pass
      aircraft-*)      AIRCRAFT_LAYERS+=("$L") ;;
      *)               SURFACE_LAYERS+=("$L") ;;
    esac
  done

  # GROUND: build the requested surface layers in ONE process sharing the halo
  # (`--source ground`); a single requested surface layer keeps its own --source
  # for parity. Surface is bbox-only — skipped under --world/--shard.
  if [ ${#SURFACE_LAYERS[@]} -gt 0 ]; then
    if $is_world || $is_shard; then
      log "skip surface (${SURFACE_LAYERS[*]}) — surface kernels are bbox/tile only (use --bbox)"
    else
      # The full surface set (all / ground) → one shared-halo `ground` pass; a
      # single requested layer → its own `--source`. Either way --output is the
      # root and the binary appends {layer}.
      if [ "${#SURFACE_LAYERS[@]}" -ge 2 ]; then SRC=ground; else SRC="${SURFACE_LAYERS[0]}"; fi
      log "build surface $SRC (${SURFACE_LAYERS[*]}) → $OUTPUT/{layer}"
      "$SURFACE" --source "$SRC" --zoom "$ZOOM" --h3r4-dir "$H3R4" \
        --prepared-dir "$PREP" --output "$OUTPUT" "${SEL_ARGS[@]}"
      for L in "${SURFACE_LAYERS[@]}"; do
        log "pyramid $L z$ZOOM → z6${bbox:+ (bbox)}"
        "$PYR" --tiles-dir "$OUTPUT/$L" --base-zoom "$ZOOM" --dst-zoom 6 --source-id "${SID[$L]}" ${bbox:+--bbox "$bbox"}
      done
    fi
  fi

  # AIRCRAFT: per sub-layer (region_runner streams the globe; --world/--shard ok).
  for L in "${AIRCRAFT_LAYERS[@]}"; do
    LDIR="$OUTPUT/$L"
    if $is_world; then log "clean $LDIR (full rebuild)"; rm -rf "$LDIR"; fi
    log "build $L → $LDIR"
    "$AIRCRAFT" --source "${L#aircraft-}" --zoom "$ZOOM" --h3r4-dir "$H3R4" \
      --prepared-dir "$PREP" --output "$LDIR" "${SEL_ARGS[@]}"
    if $is_shard; then
      log "sharded — built z$ZOOM only; pyramid $L after merging shards"
    else
      log "pyramid $L z$ZOOM → z6${bbox:+ (bbox)}"
      "$PYR" --tiles-dir "$LDIR" --base-zoom "$ZOOM" --dst-zoom 6 --source-id "${SID[$L]}" ${bbox:+--bbox "$bbox"}
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
