#!/bin/bash
# build-heatmap.sh — orchestrate the whole noise heatmap: build each requested
# layer's z12 tiles + zoom pyramid (z2-11), then the precomputed `total/`
# (energy-sum of every layer, the default all-layers-on view).
#
# Each layer is its own loose staging tree under build/{layer}/ with a distinct
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
# Env: DATA_YEAR=2026  DATA_ROOT=data  OUTPUT=$DATA_ROOT/tiles/$DATA_YEAR/build  ZOOM=12
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_YEAR="${DATA_YEAR:-$(cat DATA_YEAR)}"  # default from committed ./DATA_YEAR (bump there yearly); env overrides
DATA_ROOT="${DATA_ROOT:-data}"
H3R4="$DATA_ROOT/prepared/$DATA_YEAR/h3r4"
PREP="$DATA_ROOT/prepared"
OUTPUT="${OUTPUT:-$DATA_ROOT/tiles/$DATA_YEAR/build}"
# The tile STORE root is its own path, NOT derived from the staging root — the
# 2026-07-09 rename decoupled them (staging=build/, store=store/; /gg Codex).
STORE_ROOT="${STORE_ROOT:-$DATA_ROOT/tiles/$DATA_YEAR/store}"
ZOOM="${ZOOM:-12}"
TARGET=engine/heatmap-aircraft/target/release
SURFACE="$TARGET/build-heatmap-surface"
AIRCRAFT="$TARGET/build-heatmap-aircraft"
PYR="$TARGET/build-pyramid"
COMBINE="$TARGET/build-heatmap-combine"
TRANSCODE="$TARGET/tile-store-transcode"
GPU_SURFACE="engine/noise-gpu/target/release/gpu-surface"  # --gpu: line layers on GPU

log() { echo "[build-heatmap] $(date '+%H:%M:%S') $*"; }
# Wall-clock-stamp each line of a long builder's output (same clock as log()), so
# the multi-day surface heartbeat carries "when" — throughput/ETA is read off the
# log. pipefail (set above) still propagates the builder's exit status.
stamp() { while IFS= read -r line; do printf '%s %s\n' "$(date '+%H:%M:%S')" "$line"; done; }

ALL_LAYERS=(road rail industrial building aircraft-airborne aircraft-cruise aircraft-ground)

# Storage redesign 2026-07: kernels stage loose per-cell tiles, then the glue
# into the store depends on the run shape —
#   FULL rebuild : tile-store-transcode (fresh store + exhaustive byte parity;
#                  a green exit licenses deleting the staging tree)
#   BBOX rebuild : tile-store-ingest    (merge-in-place; every blob decoded +
#                  validated + source_id-checked before it enters the store)
# A bbox run stages into a RUN-SCOPED dir so the ingest sees exactly this
# run's layers, never leftovers from an older staging.
INGEST="$TARGET/tile-store-ingest"

# Parse --source + combine flags; forward everything else (the selection:
# --bbox / --tile-x/--tile-y / --world / --shard) verbatim to the builders.
SOURCE=all
COMBINE_ONLY=false
NO_COMBINE=false
USE_GPU=false
SEL_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:?--source needs a value}"; shift 2 ;;
    --combine-only) COMBINE_ONLY=true; shift ;;
    --no-combine) NO_COMBINE=true; shift ;;
    --gpu) USE_GPU=true; shift ;;   # line layers (road/rail) → GPU, point layers ∥ on CPU
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

# Bbox runs stage into a run-scoped dir (see the glue note above) and the
# staging is deleted after a clean ingest — it is reproducible kernel output.
if [ -n "$bbox" ]; then
  OUTPUT="$OUTPUT/.bbox-run-$$"
  mkdir -p "$OUTPUT"
  # Deleted ONLY on success (end of script) — a failed run keeps its staging
  # for post-mortem (/gg both models).
  BBOX_STAGING="$OUTPUT"
fi

# Rebuild — Fastify dlopen + long jobs cache stale binaries (CLAUDE.md).
log "rebuilding (release)"
cargo build --release --manifest-path engine/heatmap-aircraft/Cargo.toml \
  --bin build-heatmap-surface --bin build-heatmap-aircraft \
  --bin build-pyramid --bin build-heatmap-combine --bin tile-store-ingest --bin tile-store-transcode

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
    elif $USE_GPU; then
      # HYBRID: the line layers (road/rail) go to the GPU while the CPU builds the
      # point/ground layers IN PARALLEL — both mmap the same tmpfs rasters, so the
      # heavy raster reads share the OS page cache (and CPU L3). GPU = throughput
      # on the dominant line scatter; CPU = the cheaper point/ground layers.
      [ -n "$bbox" ] || { log "ERROR: --gpu requires --bbox"; exit 1; }
      # S-3 GPU dense/sparse routing gate: rural road on GPU is a measured 0.82× loss
      # (docs/dev/gpu-benchmark-results.md). Gate by total roads.arrow + railways.arrow
      # bytes over the R4 cells COVERING the bbox (~2 km sampling, the cluster
      # master's polyfill idiom — a whole-tree scan would always read "dense" and
      # walk 121k dirs on the world host). GPU_LINE_MIN_MB default = 2 MB matches
      # the cluster's DENSE_LINE_MB — the same measured dense/sparse boundary.
      # The same R4 set feeds the C9 barrier gate: the GPU kernel has no barrier
      # input, so any barriers.arrow in the bbox routes the line layers to the CPU
      # vector path (mirrors cluster-build-chunk.sh; 11 dB divergence measured on
      # barrier-dense LKPR without it, 2026-06-12). UNLESS QM_GPU_BARRIERS=1: then
      # gpu-surface screens the vector walls itself (kernel projection-and-snap;
      # spike GO 2026-06-12, 1.97× on barrier-dense vs 1.0× CPU demotion). Default
      # ON (owner-directed 2026-06-13): validated mean 0.002 / max 1.5 dB vs the CPU
      # truth — within 30 m-data noise; QM_GPU_BARRIERS=0 forces the CPU demotion.
      GPU_LINE_MIN_MB="${GPU_LINE_MIN_MB:-2}"
      QM_GPU_BARRIERS="${QM_GPU_BARRIERS:-1}"
      bbox_line_bytes=0
      bbox_has_barriers=0
      while read -r r4; do
        [ -d "$H3R4/$r4" ] || continue
        for f in "$H3R4/$r4/roads.arrow" "$H3R4/$r4/railways.arrow"; do
          [ -f "$f" ] && bbox_line_bytes=$((bbox_line_bytes + $(stat -c%s "$f" 2>/dev/null || echo 0)))
        done
        [ -s "$H3R4/$r4/barriers.arrow" ] && bbox_has_barriers=1
      done < <(python3 - "$bbox" <<'PY'
import sys, h3
s, w, n, e = (float(x) for x in sys.argv[1].split(","))
s, n = min(s, n), max(s, n); w, e = min(w, e), max(w, e)
cells = set()
lat = s
while lat <= n + 1e-9:
    lon = w
    while lon <= e + 1e-9:
        cells.add(h3.latlng_to_cell(lat, lon, 4))
        lon += 0.02
    lat += 0.02
# grid_disk(1) union: the builders load RING sources per output cell, so both
# the barrier check (correctness — 1,868 world cells have a neighbour-only
# barrier) and the byte sum (a ring-dense border bbox is NOT sparse) must see
# the ring, not just the covering cells.
ring = set()
for c in cells:
    ring.update(h3.grid_disk(c, 1))
for c in sorted(ring):
    print(c)
PY
)
      # Gate ON: the GPU kernel screens vector barriers, so don't demote on their
      # presence (S-3 sparse demotion below still applies). gpu-surface gets
      # QM_GPU_BARRIERS=1 in its env to actually upload + screen them.
      if [ "$QM_GPU_BARRIERS" = 1 ] && [ "$bbox_has_barriers" -eq 1 ]; then
        log "QM_GPU_BARRIERS=1 — barriers in bbox stay on GPU (kernel screens vector walls)"
        bbox_has_barriers=0
      fi
      gpu_layers=(); cpu_layers=()
      for L in "${SURFACE_LAYERS[@]}"; do
        case "$L" in
          road | rail)
            if [ "$bbox_has_barriers" -eq 1 ] \
              || [ "$bbox_line_bytes" -lt "$((GPU_LINE_MIN_MB * 1000000))" ]; then
              cpu_layers+=("$L")
            else
              gpu_layers+=("$L")
            fi ;;
          *) cpu_layers+=("$L") ;;
        esac
      done
      if [ "${#gpu_layers[@]}" -eq 0 ]; then
        if [ "$bbox_has_barriers" -eq 1 ]; then
          log "barriers in bbox — line layers on CPU (GPU kernel is barrier-blind, C9)"
        else
          log "sparse bbox (${bbox_line_bytes} B < ${GPU_LINE_MIN_MB} MB) — road/rail on CPU (GPU 0.82× rural loss, S-3)"
        fi
      fi
      # --features gpu pulls in cudarc + the nvcc PTX build; build.rs fails with a
      # clear message if nvcc is missing, so this build is the single GPU-host gate.
      log "rebuilding gpu-surface (needs nvcc on this host)"
      cargo build --release --manifest-path engine/noise-gpu/Cargo.toml --features gpu --bin gpu-surface
      gpu_pid=""; cpu_pid=""
      if [ ${#gpu_layers[@]} -gt 0 ]; then
        log "GPU surface: ${gpu_layers[*]} → $OUTPUT/{layer}"
        ( IFS=,; NOISE_GPU_PREPARED="$PREP" DATA_YEAR="$DATA_YEAR" QM_GPU_BARRIERS="$QM_GPU_BARRIERS" \
            scripts/memcap "$GPU_SURFACE" --layers "${gpu_layers[*]}" --bbox "$bbox" --output "$OUTPUT" ) 2>&1 | stamp &
        gpu_pid=$!
      fi
      if [ ${#cpu_layers[@]} -gt 0 ]; then
        # Build exactly cpu_layers via `ground` minus everything not requested.
        excl=(); for L in road rail industrial building aircraft-ground; do
          [[ " ${cpu_layers[*]} " == *" $L "* ]] || excl+=(--exclude "$L")
        done
        log "CPU surface: ${cpu_layers[*]} → $OUTPUT/{layer}"
        scripts/memcap "$SURFACE" --source ground "${excl[@]}" --zoom "$ZOOM" --h3r4-dir "$H3R4" \
          --prepared-dir "$PREP" --output "$OUTPUT" "${SEL_ARGS[@]}" 2>&1 | stamp &
        cpu_pid=$!
      fi
      [ -n "$gpu_pid" ] && wait "$gpu_pid"
      [ -n "$cpu_pid" ] && wait "$cpu_pid"
      log "ingest staged layers (bbox) → store"
      "$INGEST" "$STORE_ROOT" "$OUTPUT" --rebuilt-bbox "$bbox"
      for L in "${SURFACE_LAYERS[@]}"; do
        [ -f "$STORE_ROOT/$L/z$ZOOM.qtsi" ] || continue
        "$PYR" --store-dir "$STORE_ROOT/$L" --base-zoom "$ZOOM" --dst-zoom 2 --bbox "$bbox"
      done
    else
      # The full surface set (all / ground) → one shared-halo `ground` pass; a
      # single requested layer → its own `--source`. Either way --output is the
      # root and the binary appends {layer}.
      if [ "${#SURFACE_LAYERS[@]}" -ge 2 ]; then SRC=ground; else SRC="${SURFACE_LAYERS[0]}"; fi
      log "build surface $SRC (${SURFACE_LAYERS[*]}) → $OUTPUT/{layer}"
      scripts/memcap "$SURFACE" --source "$SRC" --zoom "$ZOOM" --h3r4-dir "$H3R4" \
        --prepared-dir "$PREP" --output "$OUTPUT" "${SEL_ARGS[@]}" 2>&1 | stamp
      if [ -n "$bbox" ]; then
        log "ingest staged layers (bbox) → store"
        "$INGEST" "$STORE_ROOT" "$OUTPUT" --rebuilt-bbox "$bbox"
        for L in "${SURFACE_LAYERS[@]}"; do
          [ -f "$STORE_ROOT/$L/z$ZOOM.qtsi" ] || continue
          "$PYR" --store-dir "$STORE_ROOT/$L" --base-zoom "$ZOOM" --dst-zoom 2 --bbox "$bbox"
        done
      else
        for L in "${SURFACE_LAYERS[@]}"; do
          log "transcode $L → store (parity-gated) + pyramid z$ZOOM→z2"
          "$TRANSCODE" "$OUTPUT/$L" "$STORE_ROOT/$L"
          "$PYR" --store-dir "$STORE_ROOT/$L" --base-zoom "$ZOOM" --dst-zoom 2
        done
      fi
    fi
  fi

  # AIRCRAFT: per sub-layer (region_runner streams the globe; --world/--shard ok).
  for L in "${AIRCRAFT_LAYERS[@]}"; do
    LDIR="$OUTPUT/$L"
    if $is_world; then log "clean $LDIR (full rebuild)"; rm -rf "$LDIR"; fi
    log "build $L → $LDIR"
    scripts/memcap "$AIRCRAFT" --source "${L#aircraft-}" --zoom "$ZOOM" --h3r4-dir "$H3R4" \
      --prepared-dir "$PREP" --output "$LDIR" "${SEL_ARGS[@]}"
    if $is_shard; then
      log "sharded — built z$ZOOM only; pyramid $L after merging shards"
    elif [ -n "$bbox" ]; then
      # Ingest EXACTLY this layer: move its staging under a fresh root so the
      # ingest walk cannot re-consume sibling layers built earlier in the loop.
      log "ingest $L (bbox) → store + pyramid"
      run=$(mktemp -d "$OUTPUT/.ingest-$L.XXXXXX")
      mv "$LDIR" "$run/$L"
      "$INGEST" "$STORE_ROOT" "$run" --rebuilt-bbox "$bbox"
      rm -rf "$run"
      "$PYR" --store-dir "$STORE_ROOT/$L" --base-zoom "$ZOOM" --dst-zoom 2 --bbox "$bbox"
    else
      log "transcode $L → store (parity-gated) + pyramid z$ZOOM→z2"
      "$TRANSCODE" "$LDIR" "$STORE_ROOT/$L"
      "$PYR" --store-dir "$STORE_ROOT/$L" --base-zoom "$ZOOM" --dst-zoom 2
    fi
  done
fi

# Combine into total/ (skip on sharded runs — combine after the merge).
if $NO_COMBINE; then
  log "skip combine (--no-combine)"
elif $is_shard; then
  log "sharded — run combine after merging shards: $COMBINE --store-root <store-root>"
elif [ -n "$bbox" ]; then
  log "combine (bbox) → $STORE_ROOT/total"
  "$COMBINE" --store-root "$STORE_ROOT" --bbox "$bbox"
else
  log "combine → $STORE_ROOT/total"
  "$COMBINE" --store-root "$STORE_ROOT"
fi
[ -n "${BBOX_STAGING:-}" ] && rm -rf "$BBOX_STAGING"
log "done → $STORE_ROOT (pack + publish: tile-store-pack <store-root> <pmtiles-dir> b<N>)"
