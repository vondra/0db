/**
 * Enrich US roads.arrow with FHWA HPMS 2022 (Highway Performance Monitoring System).
 *
 * Source: ArcGIS REST FeatureServer
 *   services.arcgis.com/xOi1kZaI0eWDREZv/.../HPMS_FULL_US_2022_Sysnomulti_view/0
 *   235,257 polyline segments with AADT for all NHS + F_SYSTEM 1-5 (Interstate +
 *   Principal Arterial + Minor Arterial + Major Collector + Minor Collector)
 *
 * Pre-downloaded into hpms-page-N.json files via curl (paginated 2000/request × 119 pages).
 *
 * License: US federal work — public domain (17 USC §105)
 *
 * Vehicle class split derived from F_SYSTEM (CNOSSOS-EU defaults):
 *   F_SYSTEM 1 (Interstate)              → 12% heavy
 *   F_SYSTEM 2 (Principal Arterial Other Freeway) → 10% heavy
 *   F_SYSTEM 3 (Principal Arterial Other) → 8% heavy
 *   F_SYSTEM 4 (Minor Arterial)           → 6% heavy
 *   F_SYSTEM 5 (Major Collector)          → 5% heavy
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-us.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-us.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_US_FHWA_HPMS } from './lib/source-ids.generated.js'

const MY_SOURCE_ID = SOURCE_ID_US_FHWA_HPMS

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/us`)

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

const PAGE_SIZE = 2000
const PAGE_COUNT = 119
const HPMS_BASE = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/HPMS_FULL_US_2022_Sysnomulti_view/FeatureServer/0'

// Contiguous US + Alaska + Hawaii bbox
const US_BBOX: [number, number, number, number] = [17.5, -180.0, 71.5, -65.0]

interface UsRoadSegment {
  midLat: number
  midLon: number
  aadt: number
  fSystem: number
  aadt_light: number
  aadt_medium: number
  aadt_heavy: number
  aadt_moto: number
}

// Heavy share by F_SYSTEM (CNOSSOS-EU Part 2 Table 2.3 defaults applied to US road categories)
const HEAVY_SHARE: Record<number, number> = {
  1: 0.12, // Interstate
  2: 0.10, // Principal Arterial Other Freeway
  3: 0.08, // Principal Arterial Other
  4: 0.06, // Minor Arterial
  5: 0.05, // Major Collector
  6: 0.04, // Minor Collector
  7: 0.03, // Local
}

async function downloadAllPages(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true })
  for (let p = 0; p < PAGE_COUNT; p++) {
    const offset = p * PAGE_SIZE
    const path = resolve(CACHE_DIR, `hpms-page-${offset}.json`)
    if (!forceDownload && existsSync(path) && statSync(path).size > 1000) continue
    if (enrichOnly) throw new Error(`--enrich-only but hpms-page-${offset}.json not cached`)
    console.log(`  Downloading hpms-page-${offset}...`)
    const url = `${HPMS_BASE}/query?where=AADT%3E0&outFields=AADT,F_SYSTEM,THROUGH_LANES,NHS,FACILITY_TYPE&f=geojson&outSR=4326&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}&orderByFields=OBJECTID`
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} for offset=${offset}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(path, buf)
  }
}

function extractCentroid(geom: any): [number, number] | null {
  if (!geom || !geom.coordinates) return null
  let sumLat = 0, sumLon = 0, n = 0
  if (geom.type === 'LineString') {
    for (const [lon, lat] of geom.coordinates) {
      sumLat += lat; sumLon += lon; n++
    }
  } else if (geom.type === 'MultiLineString') {
    for (const line of geom.coordinates) {
      for (const [lon, lat] of line) {
        sumLat += lat; sumLon += lon; n++
      }
    }
  } else return null
  if (n === 0) return null
  return [sumLat / n, sumLon / n]
}

function parseAllPages(): UsRoadSegment[] {
  const records: UsRoadSegment[] = []
  for (let p = 0; p < PAGE_COUNT; p++) {
    const offset = p * PAGE_SIZE
    const path = resolve(CACHE_DIR, `hpms-page-${offset}.json`)
    if (!existsSync(path)) continue
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    for (const feat of data.features || []) {
      const props = feat.properties || {}
      const aadt = parseInt(props.AADT || '0')
      if (aadt <= 0) continue

      const coords = extractCentroid(feat.geometry)
      if (!coords) continue
      const [lat, lon] = coords
      if (lat < US_BBOX[0] || lat > US_BBOX[2] || lon < US_BBOX[1] || lon > US_BBOX[3]) continue

      const fSystem = parseInt(props.F_SYSTEM || '7')
      const heavyShare = HEAVY_SHARE[fSystem] ?? 0.05

      // CNOSSOS classes
      const aadt_moto = Math.round(aadt * 0.01)
      const totalHeavy = Math.round(aadt * heavyShare)
      const aadt_medium = Math.round(totalHeavy * 0.20) // ~20% buses + light trucks
      const aadt_heavy = totalHeavy - aadt_medium
      const aadt_light = Math.max(0, aadt - totalHeavy - aadt_moto)

      records.push({
        midLat: lat,
        midLon: lon,
        aadt,
        fSystem,
        aadt_light,
        aadt_medium,
        aadt_heavy,
        aadt_moto,
      })
    }
  }
  return records
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function enrichArrows(sites: UsRoadSegment[]): Promise<void> {
  // Build spatial grid (1km cells)
  const grid = new Map<string, UsRoadSegment[]>()
  for (const s of sites) {
    const key = `${Math.floor(s.midLat * 100)}_${Math.floor(s.midLon * 100)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }
  console.log(`\n  Grid cells: ${grid.size}`)

  // Pre-filter US hexes
  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (lat >= US_BBOX[0] && lat <= US_BBOX[2] && lon >= US_BBOX[1] && lon <= US_BBOX[3]) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  US hexes with roads.arrow: ${hexDirs.length}\n`)

  let totalSeg = 0, matched = 0, preserved = 0, hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const arrowPath = resolve(H3R4_DIR, hex, 'roads.arrow')
    const buf = readFileSync(arrowPath)
    const table = tableFromIPC(buf)
    const numRows = table.numRows
    if (numRows === 0) continue

    const startLats = table.getChild('start_lat')
    const startLons = table.getChild('start_lon')
    const endLats = table.getChild('end_lat')
    const endLons = table.getChild('end_lon')
    const existingLight = table.getChild('aadt_light')
    const existingMedium = table.getChild('aadt_medium')
    const existingHeavy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')
    const existingSourceId = table.getChild('source_id')

    if (!startLats || !startLons || !endLats || !endLons) continue

    const aadtLight = new Int32Array(numRows)
    const aadtMedium = new Int32Array(numRows)
    const aadtHeavy = new Int32Array(numRows)
    const aadtMoto = new Int32Array(numRows)
    const sourceId = new Uint16Array(numRows)
    let hexMatched = 0

    // Seed output columns from existing Arrow state; priority rule decides per row.
    for (let i = 0; i < numRows; i++) {
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMedium?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHeavy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
      sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    }

    for (let i = 0; i < numRows; i++) {
      totalSeg++

      // Priority gate: if a higher-priority dataset already owns this row, leave it.
      if (!shouldOverwrite(sourceId[i], MY_SOURCE_ID)) {
        if (sourceId[i] !== 0) preserved++
        continue
      }

      const sLat = startLats.get(i) as number
      const sLon = startLons.get(i) as number
      const eLat = endLats.get(i) as number
      const eLon = endLons.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      const gy = Math.floor(midLat * 100)
      const gx = Math.floor(midLon * 100)
      let best: UsRoadSegment | null = null
      let bestDist = 200

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cell = grid.get(`${gy + dy}_${gx + dx}`)
          if (!cell) continue
          for (const s of cell) {
            const d = haversineM(midLat, midLon, s.midLat, s.midLon)
            if (d < bestDist) { bestDist = d; best = s }
          }
        }
      }

      if (best) {
        // Whole-row atomic write — payload + dataset_id together.
        aadtLight[i] = best.aadt_light
        aadtMedium[i] = best.aadt_medium
        aadtHeavy[i] = best.aadt_heavy
        aadtMoto[i] = best.aadt_moto
        sourceId[i] = MY_SOURCE_ID
        hexMatched++
        matched++
      }
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'source_id'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
      columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
      columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
      columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
      columns['source_id'] = vectorFromArray(sourceId, new Uint16())
      const enriched = makeTable(columns)
      writeFileSync(arrowPath, Buffer.from(tableToIPC(enriched, 'file')))
      hexesUpdated++
    }

    if (hi % 200 === 0 || hi === hexDirs.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${elapsed}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched.toLocaleString()} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments scanned: ${totalSeg.toLocaleString()}`)
  console.log(`  Preserved (continental): ${preserved.toLocaleString()}`)
  console.log(`  Newly matched: ${matched.toLocaleString()} (${(100 * matched / Math.max(totalSeg, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${hexDirs.length}`)

  const top = [...sites].sort((a, b) => b.aadt - a.aadt).slice(0, 15)
  console.log(`\n  Top 15 HPMS AADT segments:`)
  for (const s of top) {
    console.log(`    F${s.fSystem}  AADT=${s.aadt.toLocaleString().padStart(8)} (${s.midLat.toFixed(3)}, ${s.midLon.toFixed(3)})`)
  }
}

async function main() {
  console.log(`=== US Road Traffic Enrichment — FHWA HPMS 2022 ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) throw new Error(`H3R4 directory not found: ${H3R4_DIR}`)

  await downloadAllPages()

  console.log(`  Parsing all HPMS pages...`)
  const records = parseAllPages()
  console.log(`  Parsed ${records.length.toLocaleString()} HPMS road segments`)

  await enrichArrows(records)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
