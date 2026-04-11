/**
 * Enrich GB roads.arrow with DfT AADF traffic counts.
 *
 * Downloads DfT road traffic statistics ZIP, extracts the most recent AADF per
 * count point, matches to OSM roads by road ref + proximity.
 *
 * Vehicle class mapping (DfT → CNOSSOS):
 *   cars_and_taxis + LGVs          → aadt_light   (Category 1)
 *   buses_and_coaches              → aadt_medium  (Category 2)
 *   all_HGVs                       → aadt_heavy   (Category 3)
 *   two_wheeled_motor_vehicles     → aadt_moto    (Category 4)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-gb.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-gb.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { tableFromIPC, tableToIPC, vectorFromArray, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/gb`)
const CACHE_ZIP = resolve(CACHE_DIR, 'dft-aadf.zip')
const CACHE_JSON = resolve(CACHE_DIR, 'dft-aadf.json')

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

const DFT_URL = 'https://storage.googleapis.com/dft-statistics/road-traffic/downloads/data-gov-uk/dft_traffic_counts_aadf.zip'

interface CountPoint {
  ref: string
  lat: number
  lon: number
  road_category: string  // M, A, B, C, U
  aadt_light: number
  aadt_medium: number
  aadt_heavy: number
  aadt_moto: number
  total: number
  year: number
}

async function downloadDft(): Promise<CountPoint[]> {
  if (!forceDownload && existsSync(CACHE_JSON)) {
    console.log(`  Using cached: ${CACHE_JSON}`)
    return JSON.parse(readFileSync(CACHE_JSON, 'utf-8'))
  }

  mkdirSync(CACHE_DIR, { recursive: true })

  if (!existsSync(CACHE_ZIP) || forceDownload) {
    if (enrichOnly) { console.error('ERROR: --enrich-only but no cache'); process.exit(1) }
    console.log('  Downloading DfT AADF...')
    const res = await fetch(DFT_URL, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    writeFileSync(CACHE_ZIP, Buffer.from(await res.arrayBuffer()))
    console.log(`  Cached ZIP: ${(readFileSync(CACHE_ZIP).length / 1e6).toFixed(1)} MB`)
  }

  // Extract CSV
  const csvPath = resolve(CACHE_DIR, 'dft_traffic_counts_aadf.csv')
  if (!existsSync(csvPath)) {
    execSync(`unzip -o "${CACHE_ZIP}" -d "${CACHE_DIR}"`, { stdio: 'pipe' })
  }

  return parseCsv(csvPath)
}

function parseCsv(csvPath: string): CountPoint[] {
  console.log('  Parsing DfT AADF CSV...')
  const lines = readFileSync(csvPath, 'utf-8').split('\n')
  const header = lines[0].split(',').map(h => h.replace(/"/g, ''))

  const ci = (name: string) => header.indexOf(name)
  const iCpId = ci('count_point_id')
  const iYear = ci('year')
  const iRoad = ci('road_name')
  const iCat = ci('road_category')
  const iLat = ci('latitude')
  const iLon = ci('longitude')
  const iCars = ci('cars_and_taxis')
  const iLGV = ci('LGVs')
  const iBus = ci('buses_and_coaches')
  const iHGV = ci('all_HGVs')
  const iMoto = ci('two_wheeled_motor_vehicles')
  const iTotal = ci('all_motor_vehicles')

  // Keep most recent year per count point
  const latest = new Map<string, CountPoint>()

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/"/g, ''))
    const cpId = cols[iCpId]
    const year = parseInt(cols[iYear])
    const lat = parseFloat(cols[iLat])
    const lon = parseFloat(cols[iLon])

    if (!cpId || !year || !lat || !lon || lat < 49 || lat > 61) continue

    const existing = latest.get(cpId)
    if (existing && existing.year >= year) continue

    const road = cols[iRoad] || ''
    // Normalize: "M1" stays "M1", "A1(M)" → "A1(M)", "A3111" → "A3111"
    const ref = road.replace(/\s+/g, '')

    latest.set(cpId, {
      ref,
      lat, lon,
      road_category: cols[iCat] || '',
      aadt_light: (parseInt(cols[iCars]) || 0) + (parseInt(cols[iLGV]) || 0),
      aadt_medium: parseInt(cols[iBus]) || 0,
      aadt_heavy: parseInt(cols[iHGV]) || 0,
      aadt_moto: parseInt(cols[iMoto]) || 0,
      total: parseInt(cols[iTotal]) || 0,
      year,
    })
  }

  const points = [...latest.values()].filter(p => p.total > 0)
  writeFileSync(CACHE_JSON, JSON.stringify(points))
  console.log(`  ${points.length} count points (most recent year per point)`)
  console.log(`  By category: M=${points.filter(p=>p.road_category==='M').length} A=${points.filter(p=>p.road_category==='PA'||p.road_category==='TA').length} B=${points.filter(p=>p.road_category==='PB'||p.road_category==='TB').length}`)
  return points
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function enrichArrows(points: CountPoint[]) {
  const refIndex = new Map<string, CountPoint[]>()
  for (const p of points) {
    if (!p.ref) continue
    const list = refIndex.get(p.ref) || []
    list.push(p)
    refIndex.set(p.ref, list)
  }
  console.log(`\n  Ref index: ${refIndex.size} unique road refs`)

  // Pre-filter UK hexes
  const allHexes = readdirSync(H3R4_DIR).filter(d => !d.startsWith('.'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (lat > 49 && lat < 61 && lon > -8.5 && lon < 2.5) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  UK hexes: ${hexDirs.length}\n`)

  let totalSeg = 0, matched = 0, preserved = 0, hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const arrowPath = resolve(H3R4_DIR, hex, 'roads.arrow')
    const buf = readFileSync(arrowPath)
    const table = tableFromIPC(buf)
    const numRows = table.numRows
    const refs = table.getChild('ref')
    const startLats = table.getChild('start_lat')
    const startLons = table.getChild('start_lon')
    const endLats = table.getChild('end_lat')
    const endLons = table.getChild('end_lon')
    const existingSource = table.getChild('traffic_source')

    if (!startLats || !startLons) continue

    const aadtLight = new Int32Array(numRows)
    const aadtMedium = new Int32Array(numRows)
    const aadtHeavy = new Int32Array(numRows)
    const aadtMoto = new Int32Array(numRows)
    const trafficSource = new Uint8Array(numRows)
    let hexMatched = 0

    for (let i = 0; i < numRows; i++) {
      totalSeg++
      const existingSrc = existingSource?.get(i) ?? 0
      if (existingSrc === 1) {
        aadtLight[i] = table.getChild('aadt_light')?.get(i) ?? 0
        aadtMedium[i] = table.getChild('aadt_medium')?.get(i) ?? 0
        aadtHeavy[i] = table.getChild('aadt_heavy')?.get(i) ?? 0
        aadtMoto[i] = table.getChild('aadt_moto')?.get(i) ?? 0
        trafficSource[i] = 1
        preserved++
        continue
      }

      const midLat = ((startLats.get(i) ?? 0) + (endLats?.get(i) ?? startLats.get(i) ?? 0)) / 2
      const midLon = ((startLons.get(i) ?? 0) + (endLons?.get(i) ?? startLons.get(i) ?? 0)) / 2
      const osmRef = refs?.get(i)?.toString().trim() || ''
      const normRef = osmRef.replace(/\s+/g, '')

      let best: CountPoint | null = null
      let bestDist = Infinity

      if (normRef && refIndex.has(normRef)) {
        for (const c of refIndex.get(normRef)!) {
          const dist = haversineM(midLat, midLon, c.lat, c.lon)
          if (dist < bestDist) { bestDist = dist; best = c }
        }
      }

      if (best && bestDist < 15000) {
        aadtLight[i] = best.aadt_light
        aadtMedium[i] = best.aadt_medium
        aadtHeavy[i] = best.aadt_heavy
        aadtMoto[i] = best.aadt_moto
        trafficSource[i] = 1
        hexMatched++
        matched++
      }
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'traffic_source'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['aadt_light'] = vectorFromArray(Array.from(aadtLight), new Int32())
      columns['aadt_medium'] = vectorFromArray(Array.from(aadtMedium), new Int32())
      columns['aadt_heavy'] = vectorFromArray(Array.from(aadtHeavy), new Int32())
      columns['aadt_moto'] = vectorFromArray(Array.from(aadtMoto), new Int32())
      columns['traffic_source'] = vectorFromArray(Array.from(trafficSource), new Uint8())
      const enriched = new table.constructor(columns)
      writeFileSync(arrowPath, tableToIPC(enriched, 'file'))
      hexesUpdated++
    }

    if (hi % 10 === 0) {
      console.log(`  [${Math.round((Date.now() - startTime) / 1000)}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments: ${totalSeg}`)
  console.log(`  Preserved: ${preserved}`)
  console.log(`  Newly matched: ${matched} (${(100 * matched / Math.max(totalSeg, 1)).toFixed(1)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}`)

  const top = points.sort((a, b) => b.total - a.total).slice(0, 10)
  console.log(`\n  Top 10 AADF:`)
  for (const p of top) {
    const hv = Math.round(100 * p.aadt_heavy / Math.max(p.total, 1))
    console.log(`    ${p.ref.padEnd(10)} AADF=${p.total.toLocaleString().padStart(7)} HV=${hv}% (${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}) [${p.year}]`)
  }
}

async function main() {
  console.log(`=== GB Road Traffic Enrichment (DfT AADF) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  const points = await downloadDft()
  console.log(`  Total count points: ${points.length}`)

  await enrichArrows(points)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error(err); process.exit(1) })
