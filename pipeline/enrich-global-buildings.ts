/**
 * Global building-height enrichment: Overture Maps → data/prepared/rasters/building/*.raw.
 *
 * Replaces the GHSL 100 m building-height baseline with per-building Overture
 * heights (MS/Google/Meta footprints + LiDAR where available). This is the
 * single largest global accuracy improvement for urban noise screening —
 * GHSL averages a 50-story tower and a 2-story house into one 100 m cell.
 *
 * This script is a thin orchestrator over two existing bash helpers:
 *   - scripts/rasters/download-overture-buildings.sh (overturemaps + gdal_rasterize)
 *   - scripts/rasters/merge-building-tiles.sh (promotes to data/prepared/rasters/building/)
 *
 * Usage:
 *   cd pipeline && npx tsx enrich-global-buildings.ts
 *   cd pipeline && npx tsx enrich-global-buildings.ts --prefix N49E016  # single tile
 *   cd pipeline && npx tsx enrich-global-buildings.ts --merge-only      # skip downloads
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { SOURCES_BY_KEY } from './lib/sources.js'

const ROOT = resolve(import.meta.dirname, '..')
const PARQUET_DIR = resolve(ROOT, 'data/enrichment/global/overture-buildings/parquet')
const RASTER_DIR = resolve(ROOT, 'data/enrichment/global/overture-buildings/rasterized')
const GHSL_SEED = resolve(ROOT, 'data/enrichment/global/overture-buildings/ghsl-backup')
const BUILDING_DIR = resolve(ROOT, 'data/prepared/rasters/building')
const CACHE_DIR = resolve(ROOT, 'data/enrichment/global/overture-buildings')
const DOWNLOAD_SH = resolve(ROOT, 'scripts/rasters/download-overture-buildings.sh')
const MERGE_SH = resolve(ROOT, 'scripts/rasters/merge-building-tiles.sh')

const DATASET = SOURCES_BY_KEY.get('global-overture')!

const args = process.argv.slice(2)
const prefixIdx = args.indexOf('--prefix')
const prefix = prefixIdx >= 0 ? args[prefixIdx + 1] : null
const mergeOnly = args.includes('--merge-only')

function countFiles(dir: string, ext: string): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter(f => f.endsWith(ext)).length
}

function checkBinary(name: string): void {
  const res = spawnSync('which', [name], { stdio: 'pipe' })
  if (res.status !== 0) {
    console.error(`ERROR: required binary not on PATH: ${name}`)
    process.exit(1)
  }
}

function run(cmd: string, cmdArgs: string[]): void {
  const label = `${cmd} ${cmdArgs.join(' ')}`
  console.log(`  $ ${label}`)
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT })
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${label}`)
  }
}

async function main(): Promise<void> {
  console.log('=== Global Buildings Enrichment (Overture Maps heights) ===\n')
  console.log(`  Dataset:  ${DATASET.name} (id=${DATASET.id}, priority=${DATASET.priority})`)
  console.log(`  Parquet:  ${PARQUET_DIR}`)
  console.log(`  Raster:   ${RASTER_DIR}`)
  console.log(`  Prepared: ${BUILDING_DIR}`)
  console.log(`  Existing prepared .raw tiles: ${countFiles(BUILDING_DIR, '.raw')}\n`)

  if (!mergeOnly) {
    checkBinary('overturemaps')
    checkBinary('gdal_rasterize')

    const parquetCached = existsSync(PARQUET_DIR) && readdirSync(PARQUET_DIR).some(f => f.endsWith('.parquet'))
    const ghslSeeded = existsSync(GHSL_SEED) && readdirSync(GHSL_SEED).some(f => f.endsWith('.raw'))
    if (!parquetCached && !ghslSeeded) {
      console.error(`ERROR: no tile-list seed available.`)
      console.error(`  Expected either parquets at ${PARQUET_DIR}`)
      console.error(`  or GHSL footprint rasters at ${GHSL_SEED}`)
      console.error(`  Populate ghsl-backup first (scripts/rasters/download-ghsl.sh)`)
      process.exit(1)
    }

    mkdirSync(PARQUET_DIR, { recursive: true })
    mkdirSync(RASTER_DIR, { recursive: true })

    console.log('--- Step 1: Download Overture parquets + rasterize to 30 m heights ---')
    const dlArgs = [DOWNLOAD_SH]
    if (prefix) dlArgs.push('--prefix', prefix)
    run('bash', dlArgs)
  }

  console.log('\n--- Step 2: Promote rasterized tiles to data/prepared/rasters/building/ ---')
  const mergeArgs = [MERGE_SH]
  if (prefix) mergeArgs.push('--prefix', prefix)
  run('bash', mergeArgs)

  const rasterizedCount = countFiles(RASTER_DIR, '.raw')
  const promotedCount = countFiles(BUILDING_DIR, '.raw')
  console.log(`\n  Rasterized tiles: ${rasterizedCount}`)
  console.log(`  Promoted tiles:   ${promotedCount}`)

  const provPath = resolve(CACHE_DIR, 'provenance.md')
  writeFileSync(
    provPath,
    `# Global Buildings Enrichment Provenance

## Source
- **Overture Maps buildings** (${DATASET.year}), ${DATASET.license}
- Download: \`overturemaps download --type=building --bbox=...\` (per 1°×1° tile)
- Registered as dataset id ${DATASET.id} key \`${DATASET.key}\` priority ${DATASET.priority}

## Processing
- Tile list seeded from parquet cache if present, else from GHSL footprint
  (data/enrichment/global/overture-buildings/ghsl-backup/*.raw)
- Per tile: download GeoParquet → gdal_rasterize building height polygons
  onto node-registered 3601×3601 grid → u8 .raw
- Height priority per building: Overture height > OSM building:levels × 3 m > 6 m default
- Output clamped to [0, 249] m (u8)

## Output
- Rasterized cache: ${RASTER_DIR} (${rasterizedCount} tiles)
- Promoted baseline: ${BUILDING_DIR} (${promotedCount} tiles)
- Format: 3601×3601 grid, u8 (meters), 30 m nominal resolution
- Naming: N{lat:02d}{E|W}{lon:03d}.raw

## Pipeline integration
- raster-reader loads dem + buildings + forest + imd tiles into mmap-backed cache
- No per-row arrow provenance — this is a raster baseline, not arrow enrichment
- Per-country scripts (enrich-buildings-cz, enrich-buildings-es) override on arrow
  side where national cadastre data is available

## Gaps
- Overture coverage is excellent in EU/NA/JP but sparse in parts of Africa & central Asia
- Where no Overture buildings exist, the promoted tile is all-zeros (no GHSL fallback)
- Heights are mostly 6 m defaults outside cities where LiDAR/cadastre is not integrated upstream

## Reproduction
- \`cd pipeline && npx tsx enrich-global-buildings.ts\` (full run)
- \`cd pipeline && npx tsx enrich-global-buildings.ts --prefix N49E016\` (single tile)
- \`cd pipeline && npx tsx enrich-global-buildings.ts --merge-only\` (promotion only)
- Underlying bash: scripts/rasters/{download-overture-buildings,merge-building-tiles}.sh

## Run date
${new Date().toISOString()}
`,
  )
  console.log(`  Provenance written to ${provPath}`)

  console.log('\n=== Done ===')
}

main().catch((err: unknown) => {
  console.error('FATAL:', err)
  process.exit(1)
})
