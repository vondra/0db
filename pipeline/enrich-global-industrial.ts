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
import { latLngToCell, gridDisk } from 'h3-js'
import { SOURCES_BY_ID, PROVENANCE_RANK } from './lib/sources.js'
import { shouldOverwrite, withArrowWrite } from './lib/provenance.js'
import {
  SOURCE_ID_EUROPE_EPRTR,
  SOURCE_ID_GLOBAL_GPPD,
  SOURCE_ID_GLOBAL_GEM_STEEL,
  SOURCE_ID_GLOBAL_GEM_CEMENT,
  SOURCE_ID_GLOBAL_GEM_COALMINE,
} from './lib/source-ids.generated.js'
import { flatDist } from './lib/spatial.js'

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, '../data/enrichment/global')
const GPPD_CACHE = resolve(CACHE_DIR, 'gppd.csv')
const EPRTR_CACHE = resolve(CACHE_DIR, 'eprtr-facilities.csv')

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

const GPPD_URL = 'https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv'

// GEM heavy-industry trackers — public map GeoJSON from GEM's DigitalOcean CDN
// (the same file the live tracker maps fetch; CC-BY-4.0, no auth gate). The
// gated "Download data" form gives a richer per-unit ZIP, but the map GeoJSON
// carries everything noise needs: point lat/lon, lifecycle `status`, and a
// plant/mine type. URLs are pinned to the release referenced by GEM's
// `maps` repo (trackers/<t>/config.js, branch gitpages-production). Bump when
// GEM publishes a newer release.
interface GemTracker {
  key: 'steel' | 'cement' | 'coalmine'
  url: string
  cache: string
  nace: string   // 6-digit NACE → engine emission profile (steel 24, cement 23, coal 05)
}

const GEM_TRACKERS: GemTracker[] = [
  {
    key: 'steel',
    url: 'https://publicgemdata.nyc3.cdn.digitaloceanspaces.com/gist/2025-10/gist_map_2025-10-07.geojson',
    cache: resolve(CACHE_DIR, 'gem-steel.geojson'),
    nace: '241000', // basic iron & steel
  },
  {
    key: 'cement',
    url: 'https://publicgemdata.nyc3.cdn.digitaloceanspaces.com/gcct/2025-07/gcct_map_2025-07-15.geojson',
    cache: resolve(CACHE_DIR, 'gem-cement.geojson'),
    nace: '235100', // cement
  },
  {
    key: 'coalmine',
    url: 'https://publicgemdata.nyc3.cdn.digitaloceanspaces.com/GCMT/2025-09/gcmt_map_2025-09-22-sectionfix.geojson',
    cache: resolve(CACHE_DIR, 'gem-coalmine.geojson'),
    nace: '051000', // hard coal mining
  },
]

// Only active sites emit noise — a retired/cancelled/mothballed/proposed plant
// must not stamp a loud NACE onto an OSM polygon. GEM status values are
// lowercase free text; this is the active allow-list.
const GEM_ACTIVE_STATUS = new Set(['operating', 'operating-pre-retirement'])

const GEM_DATASET_ID: Record<GemTracker['key'], number> = {
  steel: SOURCE_ID_GLOBAL_GEM_STEEL,
  cement: SOURCE_ID_GLOBAL_GEM_CEMENT,
  coalmine: SOURCE_ID_GLOBAL_GEM_COALMINE,
}

// E-PRTR facility data — European Pollutant Release and Transfer Register
const EPRTR_URLS = [
  'https://industry.eea.europa.eu/api/v1/download/facilities?format=csv',
  'https://industry.eea.europa.eu/download?format=csv',
]

const GPPD_DATASET_ID = SOURCE_ID_GLOBAL_GPPD
const EPRTR_DATASET_ID = SOURCE_ID_EUROPE_EPRTR

// E-PRTR/GPPD coordinates are reporting centroids, not the OSM polygon's spot,
// and big sites span >500 m, so match within 2 km. Restored from the old EU-only
// pass after /gg (2026-06-25) found a refactor had silently shrunk this to 500 m,
// dropping ~75% of matches. Sites are spatially sparse → over-reach is rare, and
// the authority/nearest pick below resolves the dense-zone overlaps.
const SEARCH_RADIUS_M = 2000

// Dataset id + authority rank of a facility, used to prefer the higher-authority
// source when several cover one polygon (E-PRTR continental-measured 5 > GPPD/GEM
// global-measured 4) instead of letting a merely-nearer GPPD point win — the
// authority order docs promise (cz-irz > europe-eprtr > {gppd, GEM}).
const facilityDatasetId = (fac: Facility): number =>
  fac.source === 'eprtr' ? EPRTR_DATASET_ID
    : fac.source === 'gppd' ? GPPD_DATASET_ID
    : GEM_DATASET_ID[fac.source.slice('gem-'.length) as GemTracker['key']]
const facilityRank = (fac: Facility): number =>
  PROVENANCE_RANK[SOURCES_BY_ID.get(facilityDatasetId(fac))?.provenance ?? 'none']

// ── Types ──

interface Facility {
  name: string
  lat: number
  lon: number
  nace: string   // 6-digit NACE code string, e.g. "350000"
  source: 'gppd' | 'eprtr' | 'gem-steel' | 'gem-cement' | 'gem-coalmine'
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

// E-PRTR Annex I main activity sectors (1-9) → representative NACE 6-digit for noise
// profiling. DISCODATA (the live source since the industry.eea endpoint died 2026-06)
// exposes the Annex I activity code, e.g. "5(a)" / "4(a)(viii)", NOT a NACE code. Sector
// granularity is enough for the emission profile — the sector fixes the plant type and
// thus the loudness class. Ref: Regulation (EC) No 166/2006 Annex I.
const EPRTR_ANNEX_SECTOR_TO_NACE: Record<number, string> = {
  1: '351100', // Energy: refineries, coke, thermal power, combustion → electricity/thermal
  2: '241000', // Metals: iron, steel, ferrous/non-ferrous → basic metals
  3: '235100', // Mineral: cement, lime, glass, ceramics → cement
  4: '201100', // Chemical: organic/inorganic, fertilizers, pharma → basic chemicals
  5: '382100', // Waste & waste-water management → waste treatment
  6: '171100', // Paper & wood production → pulp/paper
  7: '014600', // Intensive livestock & aquaculture → animal production
  8: '101100', // Animal/vegetable products (food & beverage) → meat processing
  9: '131000', // Other: textile, leather, surface treatment, shipyards → textiles
}

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
  const naceCol = cols.find(c => /^(nace|economic_?activity|nace_?code|main_?activity|economicactivitycode|nacemaineconomicactivitycode|annex_?activity|eprtr_?annex)/i.test(c)) || ''

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
    const raw = (r[naceCol] || '').trim()
    let nace: string

    // E-PRTR Annex I activity code (e.g. "5(a)", "4(a)(viii)") → map sector 1-9 to NACE.
    // The legacy industry.eea endpoint gave a literal NACE; DISCODATA gives the Annex code.
    const annexSector = raw.match(/^\s*(\d{1,2})\s*[.(]/)
    if (annexSector && raw.includes('(')) {
      nace = EPRTR_ANNEX_SECTOR_TO_NACE[parseInt(annexSector[1], 10)] || ''
      if (!nace) continue
    } else {
      nace = raw.replace(/^[A-Z]\s*/i, '').replace(/^NACE\s*/i, '').replace(/\./g, '').replace(/[^0-9]/g, '')
      if (!nace || nace.length < 2) continue
      while (nace.length < 6) nace += '0'
      if (nace.length > 6) nace = nace.substring(0, 6)
    }

    const div = parseInt(nace.substring(0, 2), 10)
    if (div < 1 || div > 99) continue

    facilities.push({ name: name || 'E-PRTR Facility', lat, lon, nace, source: 'eprtr' })
  }

  console.log(`  E-PRTR: ${facilities.length} facilities with valid coordinates + NACE`)
  return facilities
}

// ── Step 4b: Download + parse GEM heavy-industry trackers ──

async function downloadGem(t: GemTracker): Promise<string | null> {
  if (enrichOnly || (!forceDownload && existsSync(t.cache))) {
    if (!existsSync(t.cache)) {
      console.log(`  WARN: no GEM ${t.key} cache at ${t.cache} — skipping`)
      return null
    }
    console.log(`  Using cached GEM ${t.key}: ${t.cache}`)
    return readFileSync(t.cache, 'utf-8')
  }

  console.log(`  Downloading GEM ${t.key} from ${t.url}...`)
  try {
    const res = await fetch(t.url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) {
      console.log(`  WARN: GEM ${t.key} download failed: ${res.status} ${res.statusText} — skipping`)
      return null
    }
    const text = await res.text()
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(t.cache, text)
    console.log(`  Cached GEM ${t.key} to ${t.cache} (${(text.length / 1024 / 1024).toFixed(1)} MB)`)
    return text
  } catch (err: any) {
    console.log(`  WARN: GEM ${t.key} download error: ${err.message} — skipping`)
    return null
  }
}

// GEM map GeoJSON: FeatureCollection of Point features. Coordinates live both
// as geometry [lon, lat] and as `Latitude`/`Longitude` properties — we prefer
// the explicit properties (some rows carry a display-jittered geometry) and
// fall back to geometry. We stamp one NACE per tracker (the sector is fixed by
// the dataset), gated on an active lifecycle `status`.
function parseGem(t: GemTracker, jsonText: string): Facility[] {
  let fc: any
  try {
    fc = JSON.parse(jsonText)
  } catch (err: any) {
    console.log(`  WARN: GEM ${t.key} — invalid JSON (${err.message}) — skipping`)
    return []
  }
  const features: any[] = Array.isArray(fc?.features) ? fc.features : []
  console.log(`  GEM ${t.key}: ${features.length} raw features`)

  const facilities: Facility[] = []
  let inactive = 0
  for (const f of features) {
    const p = f?.properties ?? {}
    const status = String(p['status'] ?? '').trim().toLowerCase()
    if (!GEM_ACTIVE_STATUS.has(status)) { inactive++; continue }

    const geom: number[] | undefined = f?.geometry?.coordinates
    const lat = parseFloat(p['Latitude'] ?? p['latitude'] ?? (geom ? geom[1] : ''))
    const lon = parseFloat(p['Longitude'] ?? p['longitude'] ?? (geom ? geom[0] : ''))
    if (!isFinite(lat) || !isFinite(lon) || lat === 0 || lon === 0) continue
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue

    const name = String(p['name'] ?? '').trim() || `GEM ${t.key}`
    facilities.push({ name, lat, lon, nace: t.nace, source: `gem-${t.key}` })
  }

  console.log(`  GEM ${t.key}: ${facilities.length} active facilities (skipped ${inactive} inactive/non-operating)`)
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
  matchedBySource: Map<Facility['source'], number>
}> {
  const hexDirs = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff'),
  )

  let totalIndustrial = 0
  let totalMatched = 0
  let hexesProcessed = 0
  let hexesWithMatches = 0
  const matchedBySource = new Map<Facility['source'], number>()
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

    // Gather facilities from this hex AND its 6 neighbours: a facility just across
    // an R4 boundary can still be within SEARCH_RADIUS_M of a polygon in this hex.
    // Same-hex-only (the post-refactor state) silently dropped those border matches.
    const hexFacilities = gridDisk(hexId, 1).flatMap(h => facByHex.get(h) ?? [])
    if (hexFacilities.length === 0) continue

    // Precompute id/rank/nace4 once per facility (constant across every polygon in
    // the hex) and drop the empty-nace GPPD sentinel (wind / blank-fuel) here so it
    // can never shadow a real match. The per-polygon loop below is then pure selection.
    const candidates = hexFacilities
      .filter(f => f.nace !== '')
      .map(f => ({
        lat: f.lat, lon: f.lon, source: f.source,
        nace4: Math.floor((parseInt(f.nace, 10) || 0) / 100),
        id: facilityDatasetId(f),
        rank: facilityRank(f),
      }))
    if (candidates.length === 0) continue

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

          // Pick the highest-authority facility within radius, tie-broken by distance.
          let bestRank = -1
          let bestDist = SEARCH_RADIUS_M
          let best: typeof candidates[number] | null = null
          for (const c of candidates) {
            const d = flatDist(lat, lon, c.lat, c.lon)
            if (d >= SEARCH_RADIUS_M) continue
            if (c.rank > bestRank || (c.rank === bestRank && d < bestDist)) {
              bestRank = c.rank
              bestDist = d
              best = c
            }
          }

          if (best) {
            const existingId = existingSourceId[i]
            if (shouldOverwrite(existingId, best.id)) {
              newNace[i] = best.nace4
              newDatasetId[i] = best.id
              hexMatched++
              totalMatched++
              matchedBySource.set(best.source, (matchedBySource.get(best.source) ?? 0) + 1)
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
        columns['nace_4digit'] = vectorFromArray(Array.from(newNace), new Uint16())
        columns['source_id'] = vectorFromArray(Array.from(newDatasetId), new Uint16())
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
  console.log(`  Matches (facility → OSM polygon within 2km): ${totalMatched}`)
  for (const [src, n] of [...matchedBySource].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${src}: ${n}`)
  }
  console.log(`  Time: ${elapsed}s`)

  return { totalIndustrial, totalMatched, hexesWithMatches, hexesProcessed, matchedBySource }
}

// ── Main ──

async function main() {
  console.log(`=== Global Industrial Enrichment (GPPD + E-PRTR + GEM heavy industry) ===\n`)
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

  console.log('\n--- Step 4b: Download + parse GEM heavy-industry trackers ---')
  let gemFacilities: Facility[] = []
  for (const t of GEM_TRACKERS) {
    const json = await downloadGem(t)
    if (json) gemFacilities = gemFacilities.concat(parseGem(t, json))
  }

  const allFacilities = [...gppdFacilities, ...eprtrFacilities, ...gemFacilities]
  console.log(`\n  Total facilities: ${allFacilities.length} (GPPD: ${gppdFacilities.length}, E-PRTR: ${eprtrFacilities.length}, GEM: ${gemFacilities.length})`)

  if (allFacilities.length === 0) {
    console.error('ERROR: No facilities parsed from any source')
    process.exit(1)
  }

  // ── Spatial index ──
  console.log('\n--- Step 5: Group by H3R4 hex ---')
  const facByHex = groupByHex(allFacilities)

  // ── Spatial join (writes directly into industrial.arrow) ──
  console.log('\n--- Step 6: Spatial join to OSM industrial polygons ---')
  const { matchedBySource } = await enrichHexes(facByHex)
  const m = (s: Facility['source']) => matchedBySource.get(s) ?? 0

  // ── Provenance ──
  const provPath = resolve(CACHE_DIR, 'provenance.md')
  const provenance = `# Global Industrial Enrichment Provenance

## Sources used
- **GPPD**: Global Power Plant Database (WRI), ${GPPD_URL}, ${gppdFacilities.length} power plants → ${m('gppd')} matched, CC-BY-4.0
- **E-PRTR**: European Pollutant Release and Transfer Register (EEA), ${eprtrFacilities.length} facilities → ${m('eprtr')} matched, CC-BY-4.0
- **GEM Iron & Steel** (NACE 2410): ${GEM_TRACKERS[0].url} → ${m('gem-steel')} matched, CC-BY-4.0
- **GEM Cement & Concrete** (NACE 2351): ${GEM_TRACKERS[1].url} → ${m('gem-cement')} matched, CC-BY-4.0
- **GEM Coal Mine** (NACE 0510): ${GEM_TRACKERS[2].url} → ${m('gem-coalmine')} matched, CC-BY-4.0

## Matching
- Spatial join: facility lat/lon → OSM industrial polygon centroid within 2 km
- H3R4 pre-filter: compare a polygon against facilities in its hex and the 6 neighbours
  (border-safe), preferring the highest-authority source then the nearest
- Written directly to industrial.arrow per-row (nace_4digit + source_id)
- Dataset priority preserves national registries (cz-irz > europe-eprtr > {global-gppd, GEM})
- GEM trackers stamp only active sites (status operating / operating pre-retirement)

## Gaps
- E-PRTR covers EU only; GPPD covers power generation (NACE 35) only
- GEM trackers add three heavy-industry sectors worldwide (steel / cement / coal mining),
  but only sites ≥ tracker capacity threshold (e.g. steel ≥ 500 ktpa) — small sites need
  country-specific registries
- Facilities without a nearby OSM industrial polygon (within 2 km) are not matched
- GEM map GeoJSON is the public subset; the gated form download carries finer per-unit detail

## Run date
${new Date().toISOString()}
`
  writeFileSync(provPath, provenance)
  console.log(`\n  Provenance written to ${provPath}`)

  console.log('\n=== Done ===')
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
