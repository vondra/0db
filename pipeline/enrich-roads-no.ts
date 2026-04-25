/**
 * Enrich NO roads.arrow with NVDB Trafikkmengde (Statens vegvesen).
 *
 * Source: nvdbapiles.atlas.vegvesen.no/vegobjekter/540 (Trafikkmengde)
 *   ~47,658 per-segment ÅDT records covering all Norwegian state/county roads
 *   Per-segment: ÅDT (4623), Andel lange % (4624 — heavy share)
 *   Cursor pagination via metadata.neste.href
 *   Requires User-Agent + X-Client headers
 *
 * Geometry: WKT LINESTRING Z (lat lon elev, ...) — note lat-first order
 *
 * License: NLOD 2.0 (Norsk lisens for offentlige data)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-no.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-no.ts --enrich-only
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-no.ts --force-download
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_SOURCE_ID = SOURCES_BY_KEY.get('no-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/no`)
const CACHE_PARSED = resolve(CACHE_DIR, 'nvdb-trafikkmengde.json')

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

const NVDB_BASE = 'https://nvdbapiles.atlas.vegvesen.no/vegobjekter/540'
const PAGE_SIZE = 1000

const NO_BBOX: [number, number, number, number] = [57.9, 4.5, 71.2, 31.2]

interface NvdbRecord {
  id: number
  vegref: string
  midLat: number
  midLon: number
  aadt: number
  heavyPct: number
  year: number
  aadt_light: number
  aadt_medium: number
  aadt_heavy: number
  aadt_moto: number
}

async function downloadAll(): Promise<NvdbRecord[]> {
  if (!forceDownload && existsSync(CACHE_PARSED)) {
    console.log(`  Using cached parsed: ${CACHE_PARSED}`)
    return JSON.parse(readFileSync(CACHE_PARSED, 'utf-8'))
  }
  if (enrichOnly) throw new Error('--enrich-only but NVDB cache missing')

  mkdirSync(CACHE_DIR, { recursive: true })
  console.log(`  Downloading NVDB Trafikkmengde via cursor pagination...`)

  const records: NvdbRecord[] = []
  let url: string | null = `${NVDB_BASE}?antall=${PAGE_SIZE}&srid=4326&inkluder=egenskaper,geometri,lokasjon`
  let pageNum = 0

  while (url) {
    pageNum++
    const res: Response = await fetch(url, {
      signal: AbortSignal.timeout(120_000),
      headers: {
        'User-Agent': 'quiet-map-noise/1.0',
        'X-Client': 'quiet-map-noise',
        'Accept': 'application/vnd.vegvesen.nvdb-v3-rev1+json',
      },
    })
    if (!res.ok) {
      console.log(`  HTTP ${res.status} on page ${pageNum} — stopping`)
      break
    }
    const data: any = await res.json()
    const objs = data.objekter || []

    for (const obj of objs) {
      const r = parseObject(obj)
      if (r) records.push(r)
    }

    const next = data.metadata?.neste?.href
    console.log(`  page ${pageNum}: ${objs.length} objects (${records.length} valid total)`)
    // NVDB caps at 800/page even when antall=1000 — rely on next cursor to stop
    if (!next || objs.length === 0) break
    url = next
  }

  console.log(`  Downloaded ${records.length} valid Trafikkmengde records`)
  writeFileSync(CACHE_PARSED, JSON.stringify(records))
  console.log(`  Cached parsed to ${CACHE_PARSED}`)
  return records
}

function parseObject(obj: any): NvdbRecord | null {
  const id = obj.id
  if (!id) return null

  // Find ÅDT (4623), heavy % (4624), year (4621) in egenskaper
  let aadt = 0, heavyPct = 0, year = 0
  for (const e of obj.egenskaper || []) {
    if (e.id === 4623) aadt = parseInt(e.verdi || '0')
    else if (e.id === 4624) heavyPct = parseInt(e.verdi || '0')
    else if (e.id === 4621) year = parseInt(e.verdi || '0')
  }
  if (aadt <= 0) return null

  // Geometry: LINESTRING Z (lat lon z, ...)
  const wkt = obj.geometri?.wkt
  if (!wkt) return null
  const lineMatch = wkt.match(/LINESTRING(?:\s*Z)?\s*\(([^)]+)\)/)
  if (!lineMatch) return null
  const coordsStr = lineMatch[1]
  const points = coordsStr.split(',').map((s: string) => s.trim().split(/\s+/).map(Number))
  if (points.length === 0) return null

  let sumLat = 0, sumLon = 0, n = 0
  for (const p of points) {
    if (p.length < 2) continue
    sumLat += p[0]
    sumLon += p[1]
    n++
  }
  if (n === 0) return null
  const midLat = sumLat / n
  const midLon = sumLon / n

  if (midLat < NO_BBOX[0] || midLat > NO_BBOX[2] || midLon < NO_BBOX[1] || midLon > NO_BBOX[3]) return null

  const vegref = obj.lokasjon?.vegsystemreferanser?.[0]?.kortform || ''

  // CNOSSOS vehicle classes:
  //   moto = 1% of aadt (no NO moto column)
  //   heavy = aadt * heavyPct/100 (lange kjøretøy includes trucks + buses + articulated)
  //   medium = ~25% of heavy (buses)
  //   light = aadt - heavy - moto
  const aadt_moto = Math.round(aadt * 0.01)
  const totalHeavy = Math.round(aadt * heavyPct / 100)
  const aadt_medium = Math.round(totalHeavy * 0.25)
  const aadt_heavy = totalHeavy - aadt_medium
  const aadt_light = Math.max(0, aadt - totalHeavy - aadt_moto)

  return {
    id,
    vegref,
    midLat,
    midLon,
    aadt,
    heavyPct,
    year,
    aadt_light,
    aadt_medium,
    aadt_heavy,
    aadt_moto,
  }
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function enrichArrows(sites: NvdbRecord[]): Promise<void> {
  // Build spatial grid (1km cells)
  const grid = new Map<string, NvdbRecord[]>()
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
      if (lat >= NO_BBOX[0] && lat <= NO_BBOX[2] && lon >= NO_BBOX[1] && lon <= NO_BBOX[3]) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  Norwegian hexes with roads.arrow: ${hexDirs.length}\n`)

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
      let best: NvdbRecord | null = null
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
      console.log(`  [${elapsed}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments scanned: ${totalSeg}`)
  console.log(`  Preserved (continental): ${preserved}`)
  console.log(`  Newly matched: ${matched} (${(100 * matched / Math.max(totalSeg, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${hexDirs.length}`)

  const top = [...sites].sort((a, b) => b.aadt - a.aadt).slice(0, 15)
  console.log(`\n  Top 15 ÅDT segments:`)
  for (const s of top) {
    console.log(`    ${s.vegref.padEnd(20)} ÅDT=${s.aadt.toLocaleString().padStart(7)} heavy=${s.heavyPct}% (${s.midLat.toFixed(3)}, ${s.midLon.toFixed(3)})`)
  }
}

async function main() {
  console.log(`=== NO Road Traffic Enrichment — NVDB Trafikkmengde ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) throw new Error(`H3R4 directory not found: ${H3R4_DIR}`)

  const records = await downloadAll()
  console.log(`  Total records: ${records.length}`)

  await enrichArrows(records)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
