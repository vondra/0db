//! Road `built_up` flag from the building raster (task #15, 2026-07-03).
//!
//! Writes a u8 `built_up` column into every roads.arrow: 1 = rural, 2 = urban,
//! 0 = unknown ONLY when the covering building-raster tile is missing. The
//! engine (`noise-compute::defaults::resolve_speed_default`) uses it to pick the
//! country's legal urban/rural implicit speed for UNTAGGED roads of classes
//! 2/3/4/9; 0 falls back to the legacy world speed table. The column is written
//! for every row regardless of class — the engine decides what consumes it.
//!
//! Decision rule (calibrated, see lib/building-raster.ts constants): a segment
//! is urban iff ≥ BUILT_UP_MIN_BUILT_PIXELS building pixels (30 m, height > 0)
//! lie in the (2·BUILT_UP_WINDOW_RADIUS_PX+1)² window around its MIDPOINT.
//!
//! Calibration matrix (agreement % vs tagged maxspeed ≤50 ⇒ urban, classes
//! 2/3/4/9; grid = window radius px × min built pixels; 2026-07-03):
//!
//!   841942dffffffff (GB, n=21755)      841e309ffffffff (CZ, n=8402)
//!         th=1  th=2  th=3  th=5  th=8       th=1  th=2  th=3  th=5  th=8
//!   r=2   81.1  79.7  74.5  60.9  48.5       62.9  57.9  52.8  43.1  35.6
//!   r=3   80.1  82.8  83.1  78.5  66.4       65.0  62.3  59.7  54.1  44.9
//!   r=5   75.6  79.9  82.5  84.7  84.2       64.2  64.5  64.2  62.5  58.4
//!   r=8   69.8  74.0  77.2  81.1  84.9       61.0  62.5  63.3  64.1  63.8
//!
//!   OVERALL pooled (n=30157): argmax r=8/th=8 = 79.0 %. The CZ column is
//!   dragged only by class 9: Brdy forest roads bulk-tagged maxspeed=50 (e.g.
//!   ways 100707616 "Dobrotivská", 100709173 "Klášterka") — tagged roads never
//!   consult built_up, and excluding class 9 the same argmax r=8/th=8 wins at
//!   85.0 % pooled (GB 84.2 %, CZ 87.4 %), so the winner is robust.
//!
//! Idempotent + safe: unchanged hexes are left byte-identical; changed hexes go
//! through `withArrowWrite` (flock + tmp + rename, never truncate in place).
//! Runs after OSM extraction, independent of AADT enrichment (only writes
//! built_up). Per-hex, self-contained → SHARD=i/n parallelizes it like
//! service-tree (wired in scripts/osm-to-h3r4.sh).
//!
//! Usage:
//!   DATA_YEAR=2026 npx tsx pipeline/enrich-roads-built-up.ts
//!   DATA_YEAR=2026 npx tsx pipeline/enrich-roads-built-up.ts --prefix 841e309
//!   DATA_YEAR=2026 npx tsx pipeline/enrich-roads-built-up.ts --bbox 49.7,13.9,50.4,15.0
//!   SHARD=0/96 DATA_YEAR=2026 node_modules/.bin/tsx pipeline/enrich-roads-built-up.ts

import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeVector, makeTable, type Table } from 'apache-arrow'
import { withArrowWrite } from './lib/provenance.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'
import { BuildingRasterSampler, BUILDING_RASTER_DIR, BUILT_UP_UNKNOWN } from './lib/building-raster.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const PREFIX = process.argv.includes('--prefix') ? process.argv[process.argv.indexOf('--prefix') + 1] : ''
const bboxArg = process.argv.includes('--bbox') ? process.argv[process.argv.indexOf('--bbox') + 1] : ''
const BBOX = bboxArg ? (bboxArg.split(',').map(Number) as [number, number, number, number]) : null
if (BBOX && (BBOX.length !== 4 || BBOX.some((x) => !Number.isFinite(x)))) {
  console.error(`ERROR: --bbox must be minLat,minLon,maxLat,maxLon (got "${bboxArg}")`)
  process.exit(1)
}

const sampler = new BuildingRasterSampler()

interface HexResult {
  rows: number
  unknown: number // built_up=0 (covering raster tile missing)
  rural: number
  urban: number
  changed: boolean
}

/** One hex: classify every segment midpoint, rewrite roads.arrow with the
 *  built_up column added (or replaced — re-runs are byte-identical no-ops). */
async function processHex(arrowPath: string): Promise<HexResult> {
  const res: HexResult = { rows: 0, unknown: 0, rural: 0, urban: 0, changed: false }
  await withArrowWrite(arrowPath, (table: Table): Table => {
    const n = table.numRows
    res.rows = n
    const sLat = table.getChild('start_lat')
    const sLon = table.getChild('start_lon')
    const eLat = table.getChild('end_lat')
    const eLon = table.getChild('end_lon')
    if (n === 0 || !sLat || !sLon) return table // empty/malformed hex — never touch

    const existing = table.getChild('built_up')
    const builtUp = new Uint8Array(n)
    let sameAsExisting = existing !== null
    for (let i = 0; i < n; i++) {
      const startLat = sLat.get(i) as number
      const startLon = sLon.get(i) as number
      const midLat = (startLat + ((eLat?.get(i) as number) ?? startLat)) / 2
      const midLon = (startLon + ((eLon?.get(i) as number) ?? startLon)) / 2
      const v = sampler.classifyBuiltUp(midLat, midLon)
      builtUp[i] = v
      if (v === BUILT_UP_UNKNOWN) res.unknown++
      else if (v === 1) res.rural++
      else res.urban++
      if (sameAsExisting && (existing!.get(i) as number) !== v) sameAsExisting = false
    }
    if (sameAsExisting) return table // idempotent re-run → leave bytes untouched

    // Rebuild preserving every other column verbatim (same idiom as
    // writeRoadAadt in lib/roads-arrow.ts, but adding a column — so the
    // schema-copy loop appends built_up when absent, replaces in place when not).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- makeTable's
    // typing wants TypedArrays; mixing existing Vectors with makeVector is fine
    // at runtime (same bridge as writeRoadAadt).
    const cols: Record<string, any> = {}
    for (const f of table.schema.fields) {
      if (f.name === 'built_up') continue
      cols[f.name] = table.getChild(f.name)!
    }
    cols['built_up'] = makeVector(builtUp)
    res.changed = true
    return makeTable(cols)
  })
  return res
}

async function main() {
  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }
  // Fail loud if the raster set itself is absent — otherwise every segment
  // world-wide would silently get built_up=0 and the engine would never see
  // an urban/rural signal.
  if (!existsSync(BUILDING_RASTER_DIR) || readdirSync(BUILDING_RASTER_DIR).length === 0) {
    console.error(`ERROR: building raster dir missing or empty: ${BUILDING_RASTER_DIR}`)
    process.exit(1)
  }

  // Same enumeration shape as continuity-fill/service-tree: --bbox → region,
  // else full tree (optionally --prefix), sorted so SHARD slices reproduce.
  let hexDirs = (
    BBOX
      ? iterateCountryHexes(H3R4_DIR, BBOX)
      : readdirSync(H3R4_DIR).filter((d) => !d.startsWith('.') && (!PREFIX || d.startsWith(PREFIX)))
  ).sort()

  if (process.env.SHARD) {
    const m = /^(\d+)\/(\d+)$/.exec(process.env.SHARD)
    const i = m ? Number(m[1]) : NaN
    const nShards = m ? Number(m[2]) : NaN
    if (!m || nShards <= 0 || i >= nShards) {
      console.error(`ERROR: invalid SHARD="${process.env.SHARD}" (expected i/n with 0 <= i < n)`)
      process.exit(1)
    }
    hexDirs = hexDirs.slice(Math.floor((i * hexDirs.length) / nShards), Math.floor(((i + 1) * hexDirs.length) / nShards))
  }

  const t0 = Date.now()
  let hexes = 0
  let changedHexes = 0
  let missingTileHexes = 0
  const totals = { rows: 0, unknown: 0, rural: 0, urban: 0 }
  for (const hexId of hexDirs) {
    const arrowPath = resolve(H3R4_DIR, hexId, 'roads.arrow')
    if (!existsSync(arrowPath)) continue
    const r = await processHex(arrowPath)
    hexes++
    if (r.changed) changedHexes++
    if (r.unknown > 0) missingTileHexes++
    totals.rows += r.rows
    totals.unknown += r.unknown
    totals.rural += r.rural
    totals.urban += r.urban
    if (hexes % 1000 === 0) {
      const dt = ((Date.now() - t0) / 1000).toFixed(0)
      console.log(`  progress: ${hexes}/${hexDirs.length} hexes in ${dt}s — ${totals.rows} rows (${totals.urban} urban / ${totals.rural} rural / ${totals.unknown} unknown)`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  ${hexes} hexes scanned, ${changedHexes} rewritten`)
  console.log(`  ${totals.rows} segments: ${totals.urban} urban (2), ${totals.rural} rural (1), ${totals.unknown} unknown (0, raster tile missing)`)
  if (missingTileHexes > 0) console.log(`  WARNING: ${missingTileHexes} hex(es) had segments over missing raster tiles`)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
