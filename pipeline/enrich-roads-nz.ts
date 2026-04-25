/**
 * Enrich NZ roads.arrow with NZTA Carriageway + Auckland Transport AADT.
 *
 * Sources:
 *   1. NZTA Waka Kotahi GEO_MASTER_GIS_Carriageway (10,835 segments, state highways)
 *      services.arcgis.com/CXBb7LAjgIIdcsPt/ArcGIS/rest/services/GEO_MASTER_GIS_Carriageway/FeatureServer/0
 *      Per-segment trafficADTEst, loadingPcHeavy, lanes, ONRC
 *   2. Auckland Transport AADT (13,743 points with full vehicle class breakdown)
 *      data-atgis.opendata.arcgis.com — adt, pcheavy, pcbus, pccar, pclcv, pchcvi, pchcvii
 *
 * License: CC-BY 4.0 (NZGOAL Waka Kotahi + AT)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-nz.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-nz.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'
import { SOURCE_ID_NZ_NATIONAL_ROADS } from './lib/source-ids.generated.js'
import { haversineM } from './lib/spatial.js'

const MY_SOURCE_ID = SOURCE_ID_NZ_NATIONAL_ROADS

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/nz`)
const AT_AADT = resolve(CACHE_DIR, 'at-aadt.geojson')

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

const NZTA_BASE = 'https://services.arcgis.com/CXBb7LAjgIIdcsPt/ArcGIS/rest/services/GEO_MASTER_GIS_Carriageway/FeatureServer/0'
const AT_URL = 'https://data-atgis.opendata.arcgis.com/datasets/a204ffd92f7546e898402e064bda6609_0.geojson'

// New Zealand bbox
const NZ_BBOX: [number, number, number, number] = [-47.5, 165, -34, 179]

interface NzRoadSegment {
  midLat: number
  midLon: number
  aadt: number
  heavyPct: number
  aadt_light: number
  aadt_medium: number
  aadt_heavy: number
  aadt_moto: number
}

async function downloadNzta(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true })
  for (let p = 0; p < 6; p++) {
    const offset = p * 2000
    const path = resolve(CACHE_DIR, `nzta-page-${offset}.json`)
    if (!forceDownload && existsSync(path) && statSync(path).size > 1000) continue
    if (enrichOnly) throw new Error(`--enrich-only but nzta-page-${offset}.json not cached`)
    console.log(`  Downloading nzta-page-${offset}...`)
    const url = `${NZTA_BASE}/query?where=1%3D1&outFields=trafficADTEst,trafficADTCount,loadingPcHeavy,lanes,roadName,ONRC&outSR=4326&f=geojson&resultOffset=${offset}&resultRecordCount=2000`
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} for offset=${offset}`)
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  }
}

async function downloadAt(): Promise<void> {
  if (!forceDownload && existsSync(AT_AADT)) return
  if (enrichOnly) throw new Error('--enrich-only but at-aadt.geojson not cached')
  mkdirSync(CACHE_DIR, { recursive: true })
  console.log(`  Downloading AT AADT...`)
  const res = await fetch(AT_URL, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for AT AADT`)
  writeFileSync(AT_AADT, Buffer.from(await res.arrayBuffer()))
}

function extractCentroid(geom: any): [number, number] | null {
  if (!geom || !geom.coordinates) return null
  if (geom.type === 'Point') return [geom.coordinates[1], geom.coordinates[0]]
  let sumLat = 0, sumLon = 0, n = 0
  if (geom.type === 'LineString') {
    for (const [lon, lat] of geom.coordinates) { sumLat += lat; sumLon += lon; n++ }
  } else if (geom.type === 'MultiLineString') {
    for (const line of geom.coordinates) {
      for (const [lon, lat] of line) { sumLat += lat; sumLon += lon; n++ }
    }
  } else return null
  if (n === 0) return null
  return [sumLat / n, sumLon / n]
}

function makeRecord(lat: number, lon: number, aadt: number, heavyPct: number): NzRoadSegment {
  const aadt_moto = Math.round(aadt * 0.01)
  const totalHeavy = Math.round(aadt * heavyPct / 100)
  const aadt_medium = Math.round(totalHeavy * 0.20) // buses + light trucks
  const aadt_heavy = totalHeavy - aadt_medium
  const aadt_light = Math.max(0, aadt - totalHeavy - aadt_moto)
  return { midLat: lat, midLon: lon, aadt, heavyPct, aadt_light, aadt_medium, aadt_heavy, aadt_moto }
}

function parseAll(): NzRoadSegment[] {
  const records: NzRoadSegment[] = []

  // 1. NZTA carriageway pages
  for (let p = 0; p < 6; p++) {
    const offset = p * 2000
    const path = resolve(CACHE_DIR, `nzta-page-${offset}.json`)
    if (!existsSync(path)) continue
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    for (const feat of data.features || []) {
      const props = feat.properties || {}
      const aadt = parseInt(props.trafficADTEst || props.trafficADTCount || '0')
      if (aadt <= 0) continue
      const heavyPct = parseFloat(props.loadingPcHeavy || '8') // default 8% if missing
      const coords = extractCentroid(feat.geometry)
      if (!coords) continue
      records.push(makeRecord(coords[0], coords[1], aadt, heavyPct))
    }
  }
  console.log(`  NZTA carriageway: ${records.length} segments`)

  // 2. AT Auckland AADT points
  const atBefore = records.length
  if (existsSync(AT_AADT)) {
    const data = JSON.parse(readFileSync(AT_AADT, 'utf-8'))
    for (const feat of data.features || []) {
      const props = feat.properties || {}
      const adt = parseInt(props.adt || '0')
      if (adt <= 0) continue
      const heavyPct = parseFloat(props.pcheavy || '0')
      const coords = extractCentroid(feat.geometry)
      if (!coords) continue
      records.push(makeRecord(coords[0], coords[1], adt, heavyPct))
    }
  }
  console.log(`  AT Auckland: ${records.length - atBefore} additional points`)

  return records
}

async function enrichArrows(sites: NzRoadSegment[]): Promise<void> {
  const grid = new Map<string, NzRoadSegment[]>()
  for (const s of sites) {
    const key = `${Math.floor(s.midLat * 100)}_${Math.floor(s.midLon * 100)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }
  console.log(`\n  Grid cells: ${grid.size}`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (lat >= NZ_BBOX[0] && lat <= NZ_BBOX[2] && lon >= NZ_BBOX[1] && lon <= NZ_BBOX[3]) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  NZ hexes with roads.arrow: ${hexDirs.length}\n`)

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
    const existingSourceId = table.getChild('source_id')
    const existingLight = table.getChild('aadt_light')
    const existingMedium = table.getChild('aadt_medium')
    const existingHeavy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')

    if (!startLats || !startLons || !endLats || !endLons) continue

    const aadtLight = new Int32Array(numRows)
    const aadtMedium = new Int32Array(numRows)
    const aadtHeavy = new Int32Array(numRows)
    const aadtMoto = new Int32Array(numRows)
    const sourceId = new Uint16Array(numRows)

    // Seed output arrays from existing values so non-matched rows are never
    // clobbered back to zero. Per-row writes happen only on match + gate pass.
    for (let i = 0; i < numRows; i++) {
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMedium?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHeavy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
      sourceId[i] = (existingSourceId?.get(i) as number) ?? 0
    }
    let hexMatched = 0

    for (let i = 0; i < numRows; i++) {
      totalSeg++
      // Priority gate: preserve existing if it has higher priority than self.
      const existingId = sourceId[i]
      if (!shouldOverwrite(existingId, MY_SOURCE_ID)) {
        preserved++
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
      let best: NzRoadSegment | null = null
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

    if (hi % 50 === 0 || hi === hexDirs.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${elapsed}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched.toLocaleString()} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments scanned: ${totalSeg.toLocaleString()}`)
  console.log(`  Newly matched: ${matched.toLocaleString()} (${(100 * matched / Math.max(totalSeg, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${hexDirs.length}`)

  const top = [...sites].sort((a, b) => b.aadt - a.aadt).slice(0, 10)
  console.log(`\n  Top 10 AADT sites:`)
  for (const s of top) {
    console.log(`    AADT=${s.aadt.toLocaleString().padStart(7)} heavy=${s.heavyPct}% (${s.midLat.toFixed(3)}, ${s.midLon.toFixed(3)})`)
  }
}

async function main() {
  console.log(`=== NZ Road Traffic Enrichment — NZTA Carriageway + AT AADT ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) throw new Error(`H3R4 directory not found: ${H3R4_DIR}`)

  await downloadNzta()
  await downloadAt()

  const records = parseAll()
  console.log(`  Total records: ${records.length}`)

  await enrichArrows(records)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
