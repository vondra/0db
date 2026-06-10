/**
 * Global industrial enrichment: GPPD (power plants) + E-PRTR (EU facilities).
 *
 * Downloads two global/EU datasets, spatial-joins to OSM industrial polygons,
 * and writes nace_4digit + source_id directly into industrial.arrow.
 *
 * WHY: OSM only gives generic "landuse=industrial". GPPD provides ~35K power plants
 * worldwide (→ NACE 35, electricity generation). E-PRTR provides ~30K EU regulated
 * facilities with actual NACE codes. Together they dramatically improve sector-specific
 * industrial noise emission profiles globally.
 *
 * Dataset provenance is written per-row; priority resolution keeps higher-priority
 * national entries intact (cz-irz > europe-eprtr > global-gppd).
 *
 * Usage:
 *   cd pipeline && npx tsx enrich-global-industrial.ts
 *   cd pipeline && npx tsx enrich-global-industrial.ts --force-download
 *   cd pipeline && npx tsx enrich-global-industrial.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeTable, vectorFromArray, Uint16 } from 'apache-arrow'
import { latLngToCell } from 'h3-js'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import { SOURCE_ID_EUROPE_EPRTR, SOURCE_ID_GLOBAL_GPPD } from './lib/source-ids.generated.js'
import { flatDist } from './lib/spatial.js'

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, '../data/enrichment/global')
const GPPD_CACHE = resolve(CACHE_DIR, 'gppd.csv')
const EPRTR_CACHE = resolve(CACHE_DIR, 'eprtr-facilities.csv')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

const GPPD_URL = 'https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv'

// E-PRTR facility data — European Pollutant Release and Transfer Register
const EPRTR_URLS = [
  'https://industry.eea.europa.eu/api/v1/download/facilities?format=csv',
  'https://industry.eea.europa.eu/download?format=csv',
]

const GPPD_DATASET_ID = SOURCE_ID_GLOBAL_GPPD
const EPRTR_DATASET_ID = SOURCE_ID_EUROPE_EPRTR

// ── Types ──

interface Facility {
  name: string
  lat: number
  lon: number
  nace: string   // 6-digit NACE code string, e.g. "350000"
  source: 'gppd' | 'eprtr'
}

// ── Flat-earth distance (meters) ──

// ── Step 1: Download GPPD ──

async function downloadGppd(): Promise<string> {
  if (enrichOnly || (!forceDownload && existsSync(GPPD_CACHE))) {
    if (!existsSync(GPPD_CACHE)) {
      console.error('ERROR: --enrich-only but no GPPD cache found at', GPPD_CACHE)
      process.exit(1)
    }
    console.log(`  Using cached GPPD: ${GPPD_CACHE}`)
    return readFileSync(GPPD_CACHE, 'utf-8')
  }

  console.log(`  Downloading GPPD from ${GPPD_URL}...`)
  const res = await fetch(GPPD_URL, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`GPPD download failed: ${res.status} ${res.statusText}`)
  const text = await res.text()

  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(GPPD_CACHE, text)
  console.log(`  Cached GPPD to ${GPPD_CACHE} (${(text.length / 1024 / 1024).toFixed(1)} MB)`)
  return text
}

// ── Step 2: Download E-PRTR ──

async function downloadEprtr(): Promise<string | null> {
  if (enrichOnly || (!forceDownload && existsSync(EPRTR_CACHE))) {
    if (!existsSync(EPRTR_CACHE)) {
      console.log('  WARN: --enrich-only but no E-PRTR cache — skipping E-PRTR')
      return null
    }
    console.log(`  Using cached E-PRTR: ${EPRTR_CACHE}`)
    return readFileSync(EPRTR_CACHE, 'utf-8')
  }

  for (const url of EPRTR_URLS) {
    console.log(`  Trying E-PRTR download: ${url}`)
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
        headers: { 'Accept': 'text/csv,application/csv,*/*' },
      })
      if (!res.ok) {
        console.log(`    HTTP ${res.status} — trying next URL`)
        continue
      }
      const contentType = res.headers.get('content-type') || ''
      const text = await res.text()

      const lines = text.split('\n').filter(l => l.trim().length > 0)
      if (lines.length < 10 || !lines[0].includes(',')) {
        console.log(`    Response doesn't look like CSV (${lines.length} lines, content-type: ${contentType}) — trying next`)
        continue
      }

      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(EPRTR_CACHE, text)
      console.log(`  Cached E-PRTR to ${EPRTR_CACHE} (${(text.length / 1024 / 1024).toFixed(1)} MB, ${lines.length} lines)`)
      return text
    } catch (err: any) {
      console.log(`    Failed: ${err.message} — trying next`)
    }
  }

  console.log('  WARN: Could not download E-PRTR from any URL. Proceeding with GPPD only.')
  console.log('  TIP: Manually place CSV at', EPRTR_CACHE, 'and run with --enrich-only')
  return null
}

// ── Step 3: Parse GPPD CSV ──

async function parseGppd(csvText: string): Promise<Facility[]> {
  const { parse } = await import('csv-parse/sync')
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[]

  console.log(`  GPPD: ${records.length} raw records, columns: ${Object.keys(records[0] || {}).slice(0, 6).join(', ')}...`)

  const facilities: Facility[] = []
  for (const r of records) {
    const lat = parseFloat(r['latitude'] || '')
    const lon = parseFloat(r['longitude'] || '')
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue

    const capacity = parseFloat(r['capacity_mw'] || '0')
    const name = (r['name'] || '').trim()
    const fuel = (r['primary_fuel'] || '').trim()

    // Power plants → NACE 35 (Electricity, gas, steam and air conditioning supply),
    // sub-classified by fuel so the engine picks the right emission profile:
    //   3512 hydro 90dB · 3511 thermal 97dB · 3599 solar 55dB.
    // Wind is modelled separately (source_type=10) — never stamp it onto an OSM
    // industrial polygon, or it inherits a thermal/hydro spectrum. Blank/unknown
    // fuel is left unstamped too: without a fuel we can't pick a profile, so we
    // keep the OSM row untouched rather than guess. nace = '' is the skip sentinel.
    let nace = ''
    if (fuel === 'Wind') nace = ''  // modelled separately — skip
    else if (fuel === 'Nuclear') nace = '351100'
    else if (fuel === 'Hydro') nace = '351200'
    else if (fuel === 'Solar') nace = '359900'
    else if (fuel === 'Gas' || fuel === 'Oil') nace = '351100'
    else if (fuel === 'Coal' || fuel === 'Petcoke') nace = '351100'
    else if (fuel === 'Biomass' || fuel === 'Waste') nace = '351100'
    else if (fuel === 'Geothermal') nace = '351200'

    facilities.push({ name: name || `Power Plant (${fuel}, ${capacity}MW)`, lat, lon, nace, source: 'gppd' })
  }

  console.log(`  GPPD: ${facilities.length} facilities with valid coordinates`)
  return facilities
}

// ── Step 4: Parse E-PRTR CSV ──

async function parseEprtr(csvText: string): Promise<Facility[]> {
  const { parse } = await import('csv-parse/sync')

  let records: Record<string, string>[]
  try {
    records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
      delimiter: ',',
    }) as Record<string, string>[]

    if (records.length > 0 && Object.keys(records[0]).length < 3) {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        relax_column_count: true,
        delimiter: ';',
      }) as Record<string, string>[]
    }
  } catch {
    records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
      delimiter: ';',
    }) as Record<string, string>[]
  }

  const cols = Object.keys(records[0] || {})
  console.log(`  E-PRTR: ${records.length} raw records, columns: ${cols.slice(0, 8).join(', ')}...`)

  const latCol = cols.find(c => /^(lat|y_?coord|facility_?lat)/i.test(c)) || ''
  const lonCol = cols.find(c => /^(lon|long|x_?coord|facility_?lon)/i.test(c)) || ''
  const nameCol = cols.find(c => /^(facility_?name|name|facilityname)/i.test(c)) || ''
  const naceCol = cols.find(c => /^(nace|economic_?activity|nace_?code|main_?activity|economicactivitycode|nacemaineconomicactivitycode)/i.test(c)) || ''

  if (!latCol || !lonCol) {
    console.log(`  WARN: E-PRTR — could not identify lat/lon columns: ${cols.join(', ')}`)
    const latCol2 = cols.find(c => c.toLowerCase().includes('lat'))
    const lonCol2 = cols.find(c => c.toLowerCase().includes('lon'))
    if (latCol2 && lonCol2) {
      console.log(`  Trying fuzzy match: lat=${latCol2}, lon=${lonCol2}`)
      return parseEprtrWithCols(records, latCol2, lonCol2, nameCol || cols.find(c => c.toLowerCase().includes('name')) || '', naceCol || cols.find(c => c.toLowerCase().includes('nace') || c.toLowerCase().includes('activity')) || '')
    }
    console.log('  WARN: Cannot parse E-PRTR — skipping')
    return []
  }

  console.log(`  E-PRTR columns mapped: lat=${latCol}, lon=${lonCol}, name=${nameCol}, nace=${naceCol}`)
  return parseEprtrWithCols(records, latCol, lonCol, nameCol, naceCol)
}

function parseEprtrWithCols(records: Record<string, string>[], latCol: string, lonCol: string, nameCol: string, naceCol: string): Facility[] {
  const facilities: Facility[] = []

  for (const r of records) {
    const lat = parseFloat((r[latCol] || '').replace(',', '.'))
    const lon = parseFloat((r[lonCol] || '').replace(',', '.'))
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue

    const name = (r[nameCol] || '').trim()
    let nace = (r[naceCol] || '').trim()

    nace = nace.replace(/^[A-Z]\s*/i, '')
    nace = nace.replace(/^NACE\s*/i, '')
    nace = nace.replace(/\./g, '')
    nace = nace.replace(/[^0-9]/g, '')

    if (!nace || nace.length < 2) continue

    while (nace.length < 6) nace += '0'
    if (nace.length > 6) nace = nace.substring(0, 6)

    const div = parseInt(nace.substring(0, 2), 10)
    if (div < 1 || div > 99) continue

    facilities.push({ name: name || 'E-PRTR Facility', lat, lon, nace, source: 'eprtr' })
  }

  console.log(`  E-PRTR: ${facilities.length} facilities with valid coordinates + NACE`)
  return facilities
}

// ── Step 5: Build spatial index (facilities grouped by H3R4 hex) ──

function groupByHex(facilities: Facility[]): Map<string, Facility[]> {
  const byHex = new Map<string, Facility[]>()
  let skipped = 0

  for (const fac of facilities) {
    try {
      const h3r4 = latLngToCell(fac.lat, fac.lon, 4)
      if (!byHex.has(h3r4)) byHex.set(h3r4, [])
      byHex.get(h3r4)!.push(fac)
    } catch {
      skipped++
    }
  }

  if (skipped > 0) console.log(`  Skipped ${skipped} facilities (invalid H3 coordinates)`)
  console.log(`  Facilities spread across ${byHex.size} H3R4 hexes`)
  return byHex
}

// ── Step 6: Spatial join to OSM industrial polygons ──

async function enrichHexes(facByHex: Map<string, Facility[]>): Promise<{
  totalIndustrial: number
  totalMatched: number
  hexesWithMatches: number
  hexesProcessed: number
}> {
  const hexDirs = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'),
  )

  let totalIndustrial = 0
  let totalMatched = 0
  let hexesProcessed = 0
  let hexesWithMatches = 0
  const startTime = Date.now()
  let lastLog = startTime

  for (const hexId of hexDirs) {
    hexesProcessed++

    const now = Date.now()
    if (now - lastLog >= 10_000) {
      const pct = (hexesProcessed / hexDirs.length * 100).toFixed(1)
      const elapsed = ((now - startTime) / 1000).toFixed(0)
      console.log(`  Progress: ${hexesProcessed}/${hexDirs.length} hexes (${pct}%), ${totalMatched} matches, ${elapsed}s elapsed`)
      lastLog = now
    }

    const hexFacilities = facByHex.get(hexId)
    if (!hexFacilities || hexFacilities.length === 0) continue

    const indPath = resolve(H3R4_DIR, hexId, 'industrial.arrow')
    if (!existsSync(indPath)) continue

    try {
      await withArrowWrite(indPath, table => {
        const n = table.numRows
        if (n === 0) return table
        totalIndustrial += n

        const clat = table.getChild('centroid_lat')
        const clon = table.getChild('centroid_lon')
        const osmIds = table.getChild('osm_id')
        const existingNaceCol = table.getChild('nace_4digit')
        const existingDatasetIdCol = table.getChild('source_id')
        if (!clat || !clon || !osmIds) return table

        const newNace = new Uint16Array(n)
        const newDatasetId = new Uint16Array(n)
        const existingSourceId = new Uint16Array(n)
        for (let j = 0; j < n; j++) {
          newNace[j] = (existingNaceCol?.get(j) as number) ?? 0
          existingSourceId[j] = (existingDatasetIdCol?.get(j) as number) ?? 0
          newDatasetId[j] = existingSourceId[j]
        }
        let hexMatched = 0
        let anyChanged = false

        for (let i = 0; i < n; i++) {
          const lat = clat.get(i) as number
          const lon = clon.get(i) as number

          let bestDist = 500
          let bestFac: Facility | null = null

          for (const fac of hexFacilities) {
            const d = flatDist(lat, lon, fac.lat, fac.lon)
            if (d < bestDist) {
              bestDist = d
              bestFac = fac
            }
          }

          // Empty nace is the GPPD skip sentinel (wind / blank-fuel plants) — leave
          // the OSM row untouched: no nace_4digit, no source_id stamp.
          if (bestFac && bestFac.nace !== '') {
            const nace6 = parseInt(bestFac.nace, 10) || 0
            const nace4 = Math.floor(nace6 / 100)
            const myId = bestFac.source === 'eprtr' ? EPRTR_DATASET_ID : GPPD_DATASET_ID
            const existingId = existingSourceId[i]
            if (shouldOverwrite(existingId, myId)) {
              newNace[i] = nace4
              newDatasetId[i] = myId
              hexMatched++
              totalMatched++
              anyChanged = true
            }
          }
        }

        if (hexMatched > 0) hexesWithMatches++
        if (!anyChanged) return table

        const columns: Record<string, any> = {}
        for (const field of table.schema.fields) {
          if (field.name === 'nace_4digit' || field.name === 'source_id') continue
          columns[field.name] = table.getChild(field.name)!
        }
        columns['nace_4digit'] = vectorFromArray(newNace, new Uint16())
        columns['source_id'] = vectorFromArray(newDatasetId, new Uint16())
        return makeTable(columns)
      })
    } catch (err: any) {
      console.log(`  WARN: Failed to process ${indPath}: ${err.message}`)
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n=== Spatial Join Results ===`)
  console.log(`  Hexes scanned: ${hexesProcessed} (${hexesWithMatches} with matches)`)
  console.log(`  Industrial sites scanned: ${totalIndustrial}`)
  console.log(`  Matches (facility → OSM polygon within 500m): ${totalMatched}`)
  console.log(`  Time: ${elapsed}s`)

  return { totalIndustrial, totalMatched, hexesWithMatches, hexesProcessed }
}

// ── Main ──

async function main() {
  console.log(`=== Global Industrial Enrichment (GPPD + E-PRTR) ===\n`)
  console.log(`  DATA_YEAR: ${YEAR}`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache dir: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    console.error(`  Run OSM extraction first, or set DATA_YEAR=...`)
    process.exit(1)
  }

  // ── Download phase ──
  console.log('--- Step 1: Download GPPD ---')
  const gppdCsv = await downloadGppd()

  console.log('\n--- Step 2: Download E-PRTR ---')
  const eprtrCsv = await downloadEprtr()

  // ── Parse phase ──
  console.log('\n--- Step 3: Parse GPPD ---')
  const gppdFacilities = await parseGppd(gppdCsv)

  let eprtrFacilities: Facility[] = []
  if (eprtrCsv) {
    console.log('\n--- Step 4: Parse E-PRTR ---')
    eprtrFacilities = await parseEprtr(eprtrCsv)
  }

  const allFacilities = [...gppdFacilities, ...eprtrFacilities]
  console.log(`\n  Total facilities: ${allFacilities.length} (GPPD: ${gppdFacilities.length}, E-PRTR: ${eprtrFacilities.length})`)

  if (allFacilities.length === 0) {
    console.error('ERROR: No facilities parsed from any source')
    process.exit(1)
  }

  // ── Spatial index ──
  console.log('\n--- Step 5: Group by H3R4 hex ---')
  const facByHex = groupByHex(allFacilities)

  // ── Spatial join (writes directly into industrial.arrow) ──
  console.log('\n--- Step 6: Spatial join to OSM industrial polygons ---')
  await enrichHexes(facByHex)

  // ── Provenance ──
  const provPath = resolve(CACHE_DIR, 'provenance.md')
  const provenance = `# Global Industrial Enrichment Provenance

## Sources used
- **GPPD**: Global Power Plant Database (WRI), ${GPPD_URL}, ${gppdFacilities.length} power plants, CC-BY-4.0
- **E-PRTR**: European Pollutant Release and Transfer Register (EEA), ${eprtrFacilities.length} facilities

## Matching
- Spatial join: facility lat/lon → nearest OSM industrial polygon centroid within 500m
- H3R4 pre-filter: only compare facilities and polygons in the same H3 resolution-4 hex
- Written directly to industrial.arrow per-row (nace_4digit + source_id)
- Dataset priority preserves national registries (cz-irz > europe-eprtr > global-gppd)

## Gaps
- E-PRTR covers EU only — rest of world relies on GPPD (power plants only)
- Facilities without nearby OSM industrial polygon are not matched
- GPPD only covers power generation (NACE 35) — other industrial sectors need country-specific registries

## Run date
${new Date().toISOString()}
`
  writeFileSync(provPath, provenance)
  console.log(`\n  Provenance written to ${provPath}`)

  console.log('\n=== Done ===')
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
