#!/usr/bin/env bash
# Download Overture Maps buildings and rasterize to 30m building-height tiles.
# For each 1° tile where GHSL exists, downloads Overture buildings and rasterizes
# heights to 3601x3601 u8 .raw (same grid as DEM).
#
# Output: data/enrichment/global/overture-buildings/rasterized/NxxExxx.raw
#   (NOT directly into building/ — merge-building-tiles.sh combines with GHSL)
#
# Resume-safe: skips tiles where output already exists at correct size.
#
# Usage:
#   ./scripts/rasters/download-overture-buildings.sh                    # all tiles
#   ./scripts/rasters/download-overture-buildings.sh --prefix N49E016   # single tile
#   JOBS=8 ./scripts/rasters/download-overture-buildings.sh             # custom parallelism
set -euo pipefail
cd "$(dirname "$0")/../.."

PARQUET_DIR="data/enrichment/global/overture-buildings/parquet"
RASTER_DIR="data/enrichment/global/overture-buildings/rasterized"
BUILDING_DIR="data/prepared/rasters/building"
JOBS="${JOBS:-16}"
PREFIX="${2:-}"
EXPECTED_SIZE=12967201   # 3601 * 3601 * 1 byte

log() { echo "[overture-bld] $(date '+%H:%M:%S') $*"; }

# ── Argument parsing ────────────────────────────────────────────────────
if [ "${1:-}" = "--prefix" ] && [ -n "$PREFIX" ]; then
    FILTER_PREFIX="$PREFIX"
else
    FILTER_PREFIX=""
fi

# ── Dependency check ────────────────────────────────────────────────────
if ! command -v overturemaps &>/dev/null; then
    log "ERROR: overturemaps CLI not found."
    log "  Install: pip install overturemaps   or   pipx install overturemaps"
    exit 1
fi
if ! command -v gdal_rasterize &>/dev/null; then
    log "ERROR: gdal_rasterize not found. Install GDAL."
    exit 1
fi
if ! python3 -c "from osgeo import gdal" &>/dev/null; then
    log "ERROR: python3 GDAL bindings not found."
    exit 1
fi

mkdir -p "$PARQUET_DIR" "$RASTER_DIR"

# ── Build tile list ─────────────────────────────────────────────────────
# Primary: parquets already downloaded (resume path).
# Fallback: GHSL footprint (tiles where buildings were ever observed) — this
# is the initial seed for a fresh run before any parquets have been cached.
TILE_LIST="/tmp/overture_bld_tiles.txt"
GHSL_SEED="data/enrichment/global/overture-buildings/ghsl-backup"
if ls "$PARQUET_DIR"/*.parquet &>/dev/null; then
    ls "$PARQUET_DIR"/*.parquet | sed 's/.*\///; s/\.parquet//' | sort > "$TILE_LIST"
elif ls "$GHSL_SEED"/*.raw &>/dev/null; then
    log "Seeding tile list from GHSL footprint: $GHSL_SEED"
    ls "$GHSL_SEED"/*.raw | sed 's/.*\///; s/\.raw//' | sort > "$TILE_LIST"
else
    log "No parquet cache and no GHSL seed — cannot determine tile list"
    rm -f "$TILE_LIST"
    exit 1
fi

if [ -n "$FILTER_PREFIX" ]; then
    grep "^${FILTER_PREFIX}" "$TILE_LIST" > "${TILE_LIST}.filtered" || true
    mv "${TILE_LIST}.filtered" "$TILE_LIST"
fi

TOTAL=$(wc -l < "$TILE_LIST")
if [ "$TOTAL" -eq 0 ]; then
    log "No tiles to process (prefix matched nothing)"
    rm -f "$TILE_LIST"
    exit 0
fi

log "Processing $TOTAL tiles ($JOBS parallel)"
log "  Parquet cache: $PARQUET_DIR"
log "  Rasterized output: $RASTER_DIR"

# ── Counter for progress ────────────────────────────────────────────────
PROGRESS_FILE="/tmp/overture_bld_progress"
echo 0 > "$PROGRESS_FILE"

process_tile() {
    local NAME="$1"
    local OUT="$RASTER_DIR/${NAME}.raw"
    local PQ="$PARQUET_DIR/${NAME}.parquet"

    # Resume: skip if output exists at correct size
    if [ -f "$OUT" ]; then
        local SZ
        SZ=$(stat --format=%s "$OUT" 2>/dev/null || echo 0)
        if [ "$SZ" -eq "$EXPECTED_SIZE" ]; then
            # Count progress even for skipped
            local C
            C=$(cat "$PROGRESS_FILE")
            echo $((C + 1)) > "$PROGRESS_FILE"
            return 0
        fi
    fi

    # Parse lat/lon from tile name (e.g. N49E016)
    local ns=${NAME:0:1}
    local lat=${NAME:1:2}
    local ew=${NAME:3:1}
    local lon=${NAME:4:3}
    lat=$((10#$lat))
    lon=$((10#$lon))
    [ "$ns" = "S" ] && lat=$((-lat))
    [ "$ew" = "W" ] && lon=$((-lon))

    local LON_MIN=$lon
    local LAT_MIN=$lat
    local LON_MAX=$((lon + 1))
    local LAT_MAX=$((lat + 1))

    # Step 1: Download Overture buildings (if not cached)
    if [ ! -f "$PQ" ]; then
        overturemaps download \
            --bbox="${LON_MIN},${LAT_MIN},${LON_MAX},${LAT_MAX}" \
            -f geoparquet \
            --type=building \
            -o "$PQ" 2>/dev/null || true
    fi

    # Skip if parquet is missing or empty
    if [ ! -f "$PQ" ] || [ ! -s "$PQ" ]; then
        rm -f "$PQ"
        local C
        C=$(cat "$PROGRESS_FILE")
        echo $((C + 1)) > "$PROGRESS_FILE"
        return 0
    fi

    # Step 2: Rasterize ALL buildings (not just those with height)
    # Height ladder: Overture height > num_floors × 3 m > 8 m default.
    # (num_floors carries OSM building:levels for OSM-sourced footprints, so
    # the documented OSM-levels tier arrives through it.) The two numbers
    # mirror noise_compute::constants::BUILDING_{FLOOR_HEIGHT,DEFAULT_HEIGHT}_M
    # — resync here on change; shell cannot import the Rust constant.
    python3 -c "
import pyarrow.parquet as pq
import numpy as np
from osgeo import ogr, gdal, osr
gdal.UseExceptions()

cols = ['geometry', 'height']
has_floors = 'num_floors' in pq.read_schema('$PQ').names
if has_floors:
    cols.append('num_floors')
t = pq.read_table('$PQ', columns=cols)
if len(t) == 0:
    raise SystemExit(0)

drv = ogr.GetDriverByName('Memory')
ds = drv.CreateDataSource('')
srs = osr.SpatialReference()
srs.ImportFromEPSG(4326)
lyr = ds.CreateLayer('bld', srs, ogr.wkbPolygon)
lyr.CreateField(ogr.FieldDefn('height', ogr.OFTReal))

DEFAULT_HEIGHT = 8.0  # = BUILDING_DEFAULT_HEIGHT_M
FLOOR_HEIGHT = 3.0    # = BUILDING_FLOOR_HEIGHT_M
geoms = t.column('geometry').to_pylist()
heights = t.column('height').to_pylist()
floors = t.column('num_floors').to_pylist() if has_floors else [None] * len(t)
for g, h, f in zip(geoms, heights, floors):
    if g is None: continue
    feat = ogr.Feature(lyr.GetLayerDefn())
    geom = ogr.CreateGeometryFromWkb(bytes(g))
    if geom is None: continue
    feat.SetGeometry(geom)
    if h is not None and h > 0:
        height = float(h)
    elif f is not None and f > 0:
        height = float(f) * FLOOR_HEIGHT
    else:
        height = DEFAULT_HEIGHT
    # u8 raster ceiling: metres in one byte, clipped at 249. True supertall
    # heights are carried by the vector obstacle store once geodata-v2
    # Phase 1 lands (which also retires this raster).
    feat.SetField('height', min(height, 249.0))
    lyr.CreateFeature(feat)

# Node-registered 3601×3601: pixel centers at integer degrees
N = 3601
hp = 0.5 / (N - 1)  # half-pixel for edge extension
target = gdal.GetDriverByName('MEM').Create('', N, N, 1, gdal.GDT_Byte)
target.SetGeoTransform([$LON_MIN - hp, 1.0 / (N - 1), 0, $LAT_MAX + hp, 0, -1.0 / (N - 1)])
target_srs = osr.SpatialReference()
target_srs.ImportFromEPSG(4326)
target.SetProjection(target_srs.ExportToWkt())
band = target.GetRasterBand(1)
band.Fill(0)
band.SetNoDataValue(0)

gdal.RasterizeLayer(target, [1], lyr, options=['ATTRIBUTE=height'])
arr = np.clip(band.ReadAsArray(), 0, 249).astype(np.uint8)
arr.tofile('$OUT')
" 2>/dev/null || rm -f "$OUT"

    # Progress
    local C
    C=$(cat "$PROGRESS_FILE")
    C=$((C + 1))
    echo "$C" > "$PROGRESS_FILE"
    if (( C % 100 == 0 )); then
        echo "[overture-bld] $(date '+%H:%M:%S') Progress: $C / $TOTAL tiles"
    fi
}
export -f process_tile
export PARQUET_DIR RASTER_DIR EXPECTED_SIZE TOTAL PROGRESS_FILE

cat "$TILE_LIST" | xargs -P "$JOBS" -I{} bash -c 'process_tile "$@"' _ {}

# ── Summary ─────────────────────────────────────────────────────────────
DONE=$(ls "$RASTER_DIR"/*.raw 2>/dev/null | wc -l)
SIZE=$(du -sh "$RASTER_DIR" 2>/dev/null | cut -f1)
log "Done: $DONE tiles with Overture heights ($SIZE)"
log "  Parquet cache: $(du -sh "$PARQUET_DIR" 2>/dev/null | cut -f1)"
rm -f "$TILE_LIST" "$PROGRESS_FILE"
