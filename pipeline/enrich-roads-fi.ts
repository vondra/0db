/**
 * Enrich FI roads.arrow with Väylävirasto Liikennemäärät 2024 KVL data.
 *
 * Source: avoinapi.vaylapilvi.fi/vaylatiedot/wfs
 *   typeNames=tiestotiedot:liikennemaarat_2024
 *   18,479 per-segment KVL records on Finnish state highways (maantiet)
 *   Geometry: MultiLineString in WGS84 (3D with elevation)
 *
 * Pre-downloaded into liikennemaarat-page-N.json files via curl (paginated 1000/request).
 *
 * Fields:
 *   kvl              = total AADT
 *   kvl_raskas       = AADT heavy vehicles (trucks + buses)
 *   kvl_yhdistelma   = AADT articulated/HGV combos (subset of kvl_raskas)
 *   alkusijainti_tie = road number (1-32 highways)
 *
 * License: CC-BY 4.0 (Väylävirasto)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-fi.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-fi.ts --enrich-only
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-fi.ts --force-download
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('fi-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/fi`)

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

const PAGE_SIZE = 1000
const PAGE_COUNT = 19 // 0..18 → 19000 (covers all 18,479 features)
const FI_BBOX: [number, number, number, number] = [59.7, 19.1, 70.1, 31.6]

const WFS_BASE = 'https://avoinapi.vaylapilvi.fi/vaylatiedot/wfs'

interface FiRoadSegment {
  internalId: number
  tie: number  // road number
  midLat: number
  midLon: number
  kvl: number
  kvlRaskas: number
  kvlYhdistelma: number
  aadt_light: number
  aadt_medium: number
  aadt_heavy: number
  aadt_moto: number
}

async function downloadAllPages(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true })
  for (let p = 0; p < PAGE_COUNT; p++) {
    const offset = p * PAGE_SIZE
    const path = resolve(CACHE_DIR, `liikennemaarat-page-${offset}.json`)
    if (!forceDownload && existsSync(path)) {
      const size = statSync(path).size
      if (size > 1000) continue
    }
    if (enrichOnly) throw new Error(`--enrich-only but liikennemaarat-page-${offset}.json not cached`)
    console.log(`  Downloading page offset=${offset}...`)
    const url = `${WFS_BASE}?service=WFS&version=2.0.0&request=GetFeature&typeNames=tiestotiedot:liikennemaarat_2024&outputFormat=application/json&srsName=EPSG:4326&count=${PAGE_SIZE}&startIndex=${offset}&sortBy=internal_id`
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} for offset=${offset}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(path, buf)
    console.log(`  Cached: ${(buf.length / 1e6).toFixed(2)} MB`)
  }
}

function extractCentroid(geom: any): [number, number] | null {
  if (!geom || !geom.coordinates) return null
  let sumLat = 0, sumLon = 0, n = 0
  if (geom.type === 'LineString') {
    for (const c of geom.coordinates) {
      sumLon += c[0]; sumLat += c[1]; n++
    }
  } else if (geom.type === 'MultiLineString') {
    for (const line of geom.coordinates) {
      for (const c of line) {
        sumLon += c[0]; sumLat += c[1]; n++
      }
    }
  } else return null
  if (n === 0) return null
  return [sumLat / n, sumLon / n]
}

function parseAllPages(): FiRoadSegment[] {
  const records: FiRoadSegment[] = []
  for (let p = 0; p < PAGE_COUNT; p++) {
    const offset = p * PAGE_SIZE
    const path = resolve(CACHE_DIR, `liikennemaarat-page-${offset}.json`)
    if (!existsSync(path)) continue
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    for (const feat of data.features || []) {
      const props = feat.properties || {}
      const kvl = parseInt(props.kvl || '0')
      if (kvl <= 0) continue

      const coords = extractCentroid(feat.geometry)
      if (!coords) continue
      const [lat, lon] = coords
      if (lat < FI_BBOX[0] || lat > FI_BBOX[2] || lon < FI_BBOX[1] || lon > FI_BBOX[3]) continue

      const kvlRaskas = parseInt(props.kvl_raskas || '0')
      const kvlYhdistelma = parseInt(props.kvl_yhdistelma || '0')

      // CNOSSOS-EU vehicle classes:
      //   moto = 1% of kvl (no Finnish moto column)
      //   heavy = kvl_yhdistelma (articulated trucks)
      //   medium = kvl_raskas - kvl_yhdistelma (rigid trucks + buses)
      //   light = kvl - kvl_raskas - moto
      const aadt_moto = Math.round(kvl * 0.01)
      const aadt_heavy = kvlYhdistelma
      const aadt_medium = Math.max(0, kvlRaskas - kvlYhdistelma)
      const aadt_light = Math.max(0, kvl - kvlRaskas - aadt_moto)

      records.push({
        internalId: parseInt(props.internal_id || '0'),
        tie: parseInt(props.alkusijainti_tie || '0'),
        midLat: lat,
        midLon: lon,
        kvl,
        kvlRaskas,
        kvlYhdistelma,
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

async function enrichArrows(sites: FiRoadSegment[]): Promise<void> {
  // Build spatial grid (1km cells) for nearest-neighbour matching
  const grid = new Map<string, FiRoadSegment[]>()
  for (const s of sites) {
    const key = `${Math.floor(s.midLat * 100)}_${Math.floor(s.midLon * 100)}`
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key)!.push(s)
  }
  console.log(`\n  Grid cells: ${grid.size}`)

  // Pre-filter Finnish hexes
  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (lat >= FI_BBOX[0] && lat <= FI_BBOX[2] && lon >= FI_BBOX[1] && lon <= FI_BBOX[3]) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  Finnish hexes with roads.arrow: ${hexDirs.length}\n`)

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
    const refs = table.getChild('ref')
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
      if (!shouldOverwrite(existingId, MY_DATASET_ID)) {
        preserved++
        continue
      }

      const sLat = startLats.get(i) as number
      const sLon = startLons.get(i) as number
      const eLat = endLats.get(i) as number
      const eLon = endLons.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      // Nearest within 200m
      const gy = Math.floor(midLat * 100)
      const gx = Math.floor(midLon * 100)
      let best: FiRoadSegment | null = null
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
        sourceId[i] = MY_DATASET_ID
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
      columns['aadt_light'] = vectorFromArray(Array.from(aadtLight), new Int32())
      columns['aadt_medium'] = vectorFromArray(Array.from(aadtMedium), new Int32())
      columns['aadt_heavy'] = vectorFromArray(Array.from(aadtHeavy), new Int32())
      columns['aadt_moto'] = vectorFromArray(Array.from(aadtMoto), new Int32())

      columns['source_id'] = vectorFromArray(sourceId, new Uint16())
      const enriched = makeTable(columns)
      writeFileSync(arrowPath, Buffer.from(tableToIPC(enriched, 'file')))
      hexesUpdated++
    }

    if (hi % 50 === 0 || hi === hexDirs.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${elapsed}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments scanned: ${totalSeg}`)
  console.log(`  Preserved (continental): ${preserved}`)
  console.log(`  Newly matched: ${matched} (${(100 * matched / Math.max(totalSeg, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${hexDirs.length}`)

  const top = [...sites].sort((a, b) => b.kvl - a.kvl).slice(0, 15)
  console.log(`\n  Top 15 KVL segments:`)
  for (const s of top) {
    console.log(`    Tie ${s.tie.toString().padStart(3)}  KVL=${s.kvl.toLocaleString().padStart(7)} heavy=${s.kvlRaskas.toLocaleString().padStart(5)}  (${s.midLat.toFixed(3)}, ${s.midLon.toFixed(3)})`)
  }
}

async function main() {
  console.log(`=== FI Road Traffic Enrichment — Väylävirasto Liikennemäärät 2024 ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) throw new Error(`H3R4 directory not found: ${H3R4_DIR}`)

  await downloadAllPages()

  const records = parseAllPages()
  console.log(`  Parsed ${records.length} traffic measurement segments`)

  await enrichArrows(records)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
