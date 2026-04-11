/**
 * Enrich DK roads.arrow with Vejdirektoratet Mastra traffic count data.
 *
 * Source: vmgeoserver.vd.dk/geosmastra/opendata/ows (WFS GeoJSON, EPSG:25832)
 *   typeNames=OPEN_DATA_NOEGLETAL_VIEW
 *   ~22,000 measurement records from 2023-2025 (paginated 3000/request)
 *   Per-station: AADT, HDT (weekday), LBIL_AADT (heavy trucks), GNS_HASTIGHED (mean speed)
 *
 * Pre-downloaded into mastra-page-N.json files via curl. Script aggregates to
 * one record per (VEJNR, KILOMETER) keeping the most recent year.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-dk.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-dk.ts --enrich-only
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-dk.ts --force-download
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'
import proj4 from 'proj4'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/dk`)

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

// Vejdirektoratet Mastra WFS — paginated GeoJSON
const PAGE_SIZE = 3000
const PAGE_OFFSETS = [0, 3000, 6000, 9000, 12000, 15000, 18000, 21000]
const MASTRA_URL = (offset: number) =>
  `https://vmgeoserver.vd.dk/geosmastra/opendata/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=OPEN_DATA_NOEGLETAL_VIEW&outputFormat=json&count=${PAGE_SIZE}&startIndex=${offset}&sortBy=AAR&CQL_FILTER=AAR%3E%3D2023`

// EPSG:25832 ETRS89/UTM32N → WGS84
proj4.defs('EPSG:25832', '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs')

// Denmark bbox
const DK_BBOX: [number, number, number, number] = [54.5, 8.0, 57.8, 13.0]

interface MastraRecord {
  vejnr: number
  vejnavn: string
  kilometer: number
  meter: number
  aar: number
  lat: number
  lon: number
  aadt: number
  lbilAadt: number
  speedLimit: number | null
  meanSpeed: number
}

interface SegmentAadt {
  vejnr: number
  ref: string  // normalized
  midLat: number
  midLon: number
  aadt_total: number
  aadt_light: number
  aadt_medium: number
  aadt_heavy: number
  aadt_moto: number
}

async function downloadAllPages(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true })
  for (const offset of PAGE_OFFSETS) {
    const path = resolve(CACHE_DIR, `mastra-page-${offset}.json`)
    if (!forceDownload && existsSync(path)) {
      continue
    }
    if (enrichOnly) {
      throw new Error(`--enrich-only but mastra-page-${offset}.json not cached`)
    }
    console.log(`  Downloading mastra page offset=${offset}...`)
    const res = await fetch(MASTRA_URL(offset), { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} for offset=${offset}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(path, buf)
    console.log(`  Cached: ${(buf.length / 1e6).toFixed(2)} MB`)
  }
}

function parseAllPages(): MastraRecord[] {
  const records: MastraRecord[] = []
  for (const offset of PAGE_OFFSETS) {
    const path = resolve(CACHE_DIR, `mastra-page-${offset}.json`)
    if (!existsSync(path)) continue
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    for (const feat of data.features || []) {
      const p = feat.properties || {}
      const coords = feat.geometry?.coordinates
      if (!coords || coords.length < 2) continue
      const [x, y] = coords as [number, number]
      const [lon, lat] = proj4('EPSG:25832', 'WGS84', [x, y])
      if (lat < DK_BBOX[0] || lat > DK_BBOX[2] || lon < DK_BBOX[1] || lon > DK_BBOX[3]) continue

      const vejnr = parseInt(p.VEJNR || '0')
      const aadt = parseInt(p.AADT || '0')
      if (!vejnr || aadt <= 0) continue
      // Skip non-motor (cycles, peds)
      if (p.KOERETOEJSART && p.KOERETOEJSART !== 'MOTORKTJ') continue

      records.push({
        vejnr,
        vejnavn: (p.VEJNAVN || '').toString(),
        kilometer: parseInt(p.KILOMETER || '0'),
        meter: parseInt(p.METER || '0'),
        aar: parseInt(p.AAR || '0'),
        lat,
        lon,
        aadt,
        lbilAadt: parseInt(p.LBIL_AADT || '0'),
        speedLimit: p.HAST_GRAENSE != null ? parseInt(p.HAST_GRAENSE) : null,
        meanSpeed: parseFloat(p.GNS_HASTIGHED || '0'),
      })
    }
  }
  return records
}

function aggregateLatest(records: MastraRecord[]): SegmentAadt[] {
  // Group by (vejnr, kilometer) and keep most recent year
  const map = new Map<string, MastraRecord>()
  for (const r of records) {
    const key = `${r.vejnr}_${r.kilometer}`
    const existing = map.get(key)
    if (!existing || r.aar > existing.aar) {
      map.set(key, r)
    }
  }

  const out: SegmentAadt[] = []
  for (const r of map.values()) {
    // Vehicle classes:
    //   moto: 1% of AADT (CNOSSOS default)
    //   heavy: LBIL_AADT (lastbil)
    //   medium: 5% of heavy as buses (split heavy)
    //   light: AADT - heavy - moto
    const aadt_moto = Math.round(r.aadt * 0.01)
    const aadt_medium = Math.round(r.lbilAadt * 0.05)
    const aadt_heavy = Math.round(r.lbilAadt - aadt_medium)
    const aadt_light = Math.max(0, r.aadt - r.lbilAadt - aadt_moto)

    // Normalize ref: VEJNR may map to "1" → could be statsvej; we use vejnavn for fallback
    // OSM Danish refs: "E20", "E45", "M3", "1" (numbered statsveje)
    const ref = r.vejnr.toString()

    out.push({
      vejnr: r.vejnr,
      ref,
      midLat: r.lat,
      midLon: r.lon,
      aadt_total: r.aadt,
      aadt_light,
      aadt_medium,
      aadt_heavy,
      aadt_moto,
    })
  }
  return out
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function enrichArrows(sites: SegmentAadt[]): Promise<void> {
  // Build spatial grid for proximity matching (1km cells)
  const grid = new Map<string, SegmentAadt[]>()
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
      if (lat >= DK_BBOX[0] && lat <= DK_BBOX[2] && lon >= DK_BBOX[1] && lon <= DK_BBOX[3]) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  Danish hexes with roads.arrow: ${hexDirs.length}\n`)

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
    let hexMatched = 0

    for (let i = 0; i < numRows; i++) {
      totalSeg++
      const existingSrc = (existingSource?.get(i) as number) ?? 0
      if (existingSrc === 1) {
        aadtLight[i] = (existingLight?.get(i) as number) ?? 0
        aadtMedium[i] = (existingMedium?.get(i) as number) ?? 0
        aadtHeavy[i] = (existingHeavy?.get(i) as number) ?? 0
        aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
        trafficSource[i] = 1
        preserved++
        continue
      }

      const sLat = startLats.get(i) as number
      const sLon = startLons.get(i) as number
      const eLat = endLats.get(i) as number
      const eLon = endLons.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      // Find nearest Mastra point within 200m (per-station data, no ref matching)
      const gy = Math.floor(midLat * 100)
      const gx = Math.floor(midLon * 100)
      let best: SegmentAadt | null = null
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
      const enriched = makeTable(columns)
      writeFileSync(arrowPath, Buffer.from(tableToIPC(enriched, 'file')))
      hexesUpdated++
    }

    if (hi % 10 === 0 || hi === hexDirs.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${elapsed}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments scanned: ${totalSeg}`)
  console.log(`  Preserved (continental): ${preserved}`)
  console.log(`  Newly matched: ${matched} (${(100 * matched / Math.max(totalSeg, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${hexDirs.length}`)

  const top = [...sites].sort((a, b) => b.aadt_total - a.aadt_total).slice(0, 15)
  console.log(`\n  Top 15 AADT counter sites:`)
  for (const s of top) {
    console.log(`    VEJNR=${s.vejnr.toString().padStart(8)}  AADT=${s.aadt_total.toLocaleString().padStart(7)} heavy=${s.aadt_heavy.toLocaleString().padStart(5)}  (${s.midLat.toFixed(3)}, ${s.midLon.toFixed(3)})`)
  }
}

async function main() {
  console.log(`=== DK Road Traffic Enrichment — Vejdirektoratet Mastra (2023+) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) throw new Error(`H3R4 directory not found: ${H3R4_DIR}`)

  await downloadAllPages()

  const records = parseAllPages()
  console.log(`  Parsed ${records.length} measurement records (motor vehicles only)`)

  const aggregated = aggregateLatest(records)
  console.log(`  Aggregated to ${aggregated.length} unique stations (latest year per location)`)

  await enrichArrows(aggregated)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
