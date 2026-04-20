/**
 * Enrich CA roads.arrow with Quebec MTQ DJMA (Débit Journalier Moyen Annuel = AADT).
 *
 * Source: ws.mapserver.transports.gouv.qc.ca WFS
 *   typeName=ms:circulation_routier
 *   ~7,767 LineString features in WGS84 covering the Quebec state highway network
 *   Per-segment DJMA + DJME (summer) + DJMH (winter) + %cam (truck share)
 *   Multi-year history (annee_en_cours + annee2..annee10)
 *
 * Format: GeoJSON FeatureCollection, parsed from `annee_en_cours` text field
 *   Example: "2024 DJMA:600 / DJME:650 / DJMH:540 / %cam:8.6 / 30e h:70"
 *
 * License: CC-BY 4.0 (donneesquebec.ca)
 *
 * Coverage: Quebec only (Ontario/BC/Alberta have provincial-only data with
 * complex tabular-to-geometry joins, not yet implemented)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-ca.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-ca.ts --enrich-only
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-ca.ts --force-download
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('ca-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/ca`)
const CACHE_QC = resolve(CACHE_DIR, 'qc-djma.geojson')

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

const QC_URL = 'https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&typename=ms:circulation_routier&srsname=EPSG:4326&outputformat=geojson'

// Canada bbox (continental)
const CA_BBOX: [number, number, number, number] = [41.5, -141.0, 84.0, -52.0]

interface QcSegment {
  midLat: number
  midLon: number
  djma: number
  truckPct: number
  aadt_light: number
  aadt_medium: number
  aadt_heavy: number
  aadt_moto: number
}

async function downloadQc(): Promise<void> {
  if (!forceDownload && existsSync(CACHE_QC)) return
  if (enrichOnly) throw new Error('--enrich-only but qc-djma.geojson not cached')
  mkdirSync(CACHE_DIR, { recursive: true })
  console.log(`  Downloading Quebec DJMA (~50 MB)...`)
  const res = await fetch(QC_URL, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(CACHE_QC, buf)
  console.log(`  Cached: ${(buf.length / 1e6).toFixed(2)} MB`)
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

function parseAnneeText(text: string): { djma: number; truckPct: number } | null {
  if (!text) return null
  // Format: "2024 DJMA:600 / DJME:650 / DJMH:540 / %cam:8.6 / 30e h:70"
  const djmaMatch = text.match(/DJMA\s*:\s*(\d+)/)
  const camMatch = text.match(/%cam\s*:\s*([\d.]+)/)
  if (!djmaMatch) return null
  const djma = parseInt(djmaMatch[1])
  if (djma <= 0) return null
  const truckPct = camMatch ? parseFloat(camMatch[1]) : 0
  return { djma, truckPct }
}

function parseQc(): QcSegment[] {
  const data = JSON.parse(readFileSync(CACHE_QC, 'utf-8'))
  const records: QcSegment[] = []
  for (const feat of data.features || []) {
    const props = feat.properties || {}

    // Try annee_en_cours first; fall back to annee2 if missing
    let parsed = parseAnneeText(props.annee_en_cours || '')
    if (!parsed) parsed = parseAnneeText(props.annee2 || '')
    if (!parsed) parsed = parseAnneeText(props.annee3 || '')
    if (!parsed) continue

    const coords = extractCentroid(feat.geometry)
    if (!coords) continue
    const [lat, lon] = coords

    // CNOSSOS classes
    const aadt_moto = Math.round(parsed.djma * 0.01)
    const totalHeavy = Math.round(parsed.djma * (parsed.truckPct || 7) / 100)
    const aadt_medium = Math.round(totalHeavy * 0.20)
    const aadt_heavy = totalHeavy - aadt_medium
    const aadt_light = Math.max(0, parsed.djma - totalHeavy - aadt_moto)

    records.push({
      midLat: lat,
      midLon: lon,
      djma: parsed.djma,
      truckPct: parsed.truckPct,
      aadt_light,
      aadt_medium,
      aadt_heavy,
      aadt_moto,
    })
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

async function enrichArrows(sites: QcSegment[]): Promise<void> {
  const grid = new Map<string, QcSegment[]>()
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
      // Quebec province roughly: 45-62 N, -79.7 to -57.1 W
      if (lat >= 44.5 && lat <= 63 && lon >= -80 && lon <= -56) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  Quebec hexes with roads.arrow: ${hexDirs.length}\n`)

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
    const existingSource = table.getChild('traffic_source')
    const existingDatasetId = table.getChild('roads_dataset_id')
    const existingLight = table.getChild('aadt_light')
    const existingMedium = table.getChild('aadt_medium')
    const existingHeavy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')

    if (!startLats || !startLons || !endLats || !endLons) continue

    const aadtLight = new Int32Array(numRows)
    const aadtMedium = new Int32Array(numRows)
    const aadtHeavy = new Int32Array(numRows)
    const aadtMoto = new Int32Array(numRows)
    const trafficSource = new Uint8Array(numRows)
    const datasetId = new Uint16Array(numRows)

    // Seed output arrays from existing values so non-matched rows are never
    // clobbered back to zero. Per-row writes happen only on match + gate pass.
    for (let i = 0; i < numRows; i++) {
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMedium?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHeavy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
      trafficSource[i] = (existingSource?.get(i) as number) ?? 0
      datasetId[i] = (existingDatasetId?.get(i) as number) ?? 0
    }
    let hexMatched = 0

    for (let i = 0; i < numRows; i++) {
      totalSeg++
      // Priority gate: preserve existing if it has higher priority than self.
      const existingId = datasetId[i]
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

      const gy = Math.floor(midLat * 100)
      const gx = Math.floor(midLon * 100)
      let best: QcSegment | null = null
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
        trafficSource[i] = 1
        datasetId[i] = MY_DATASET_ID
        hexMatched++
        matched++
      }
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'traffic_source', 'roads_dataset_id'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['aadt_light'] = vectorFromArray(Array.from(aadtLight), new Int32())
      columns['aadt_medium'] = vectorFromArray(Array.from(aadtMedium), new Int32())
      columns['aadt_heavy'] = vectorFromArray(Array.from(aadtHeavy), new Int32())
      columns['aadt_moto'] = vectorFromArray(Array.from(aadtMoto), new Int32())
      columns['traffic_source'] = vectorFromArray(Array.from(trafficSource), new Uint8())

      columns['roads_dataset_id'] = vectorFromArray(datasetId, new Uint16())
      const enriched = makeTable(columns)
      writeFileSync(arrowPath, Buffer.from(tableToIPC(enriched, 'file')))
      hexesUpdated++
    }

    if (hi % 25 === 0 || hi === hexDirs.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${elapsed}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched.toLocaleString()} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments scanned: ${totalSeg.toLocaleString()}`)
  console.log(`  Preserved (continental): ${preserved.toLocaleString()}`)
  console.log(`  Newly matched: ${matched.toLocaleString()} (${(100 * matched / Math.max(totalSeg, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${hexDirs.length}`)

  const top = [...sites].sort((a, b) => b.djma - a.djma).slice(0, 15)
  console.log(`\n  Top 15 DJMA segments:`)
  for (const s of top) {
    console.log(`    DJMA=${s.djma.toLocaleString().padStart(6)} cam=${s.truckPct}% (${s.midLat.toFixed(3)}, ${s.midLon.toFixed(3)})`)
  }
}

async function main() {
  console.log(`=== CA Road Traffic Enrichment — Quebec MTQ DJMA ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) throw new Error(`H3R4 directory not found: ${H3R4_DIR}`)

  await downloadQc()
  console.log(`  Parsing Quebec DJMA GeoJSON...`)
  const records = parseQc()
  console.log(`  Parsed ${records.length.toLocaleString()} DJMA segments`)

  await enrichArrows(records)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
