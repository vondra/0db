/**
 * Enrich PL roads.arrow with GDDKiA Generalny Pomiar Ruchu (GPR) 2020/2021 data.
 *
 * Sources (Generalna Dyrekcja Dróg Krajowych i Autostrad — GDDKiA):
 *   National roads SHP geometry: 2,290 segments, EPSG:2180 (auto-reprojected to WGS84 by shpjs)
 *   National roads AADT XLS:     2,290 measurement points with full vehicle class split
 *   Provincial roads (DW) AADT XLS: 3,124 segments (no geometry — matched by ref + proximity)
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-pl.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-pl.ts --enrich-only
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-pl.ts --force-download
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'
import * as XLSX from 'xlsx'
import shp from 'shpjs'

const MY_SOURCE_ID = SOURCES_BY_KEY.get('pl-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/pl`)
const CACHE_NATIONAL_XLS = resolve(CACHE_DIR, 'gpr-2020-national.xls')
const CACHE_PROVINCIAL_XLS = resolve(CACHE_DIR, 'gpr-2020-provincial.xls')
const CACHE_SHP_ZIP = resolve(CACHE_DIR, 'gpr-2020-segments-shp.zip')
const CACHE_PARSED = resolve(CACHE_DIR, 'gpr-2020-parsed.json')

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

// GDDKiA URLs (gov.pl attachment IDs valid as of 2026-04)
const NATIONAL_XLS_URL = 'https://www.gov.pl/attachment/51021048-4885-4ced-a487-3b58cd513abc'
const PROVINCIAL_XLS_URL = 'https://www.gov.pl/attachment/bc113506-2cb6-45fb-9e83-7c8e60aa11fd'
const SHP_ZIP_URL = 'https://www.gov.pl/attachment/540a9afe-df60-4610-bc93-808a925e0ed0'

// Poland mainland bounding box
const PL_BBOX: [number, number, number, number] = [49.0, 14.0, 55.0, 24.5]

interface SegmentRecord {
  nr2020: string         // measurement point ID (joins to SHP)
  ref: string            // road number normalized (e.g. "A1", "S7", "DK1", "DW806")
  isProvincial: boolean
  midLat: number
  midLon: number
  imdTot: number
  aadt_light: number     // cars (col 9 nat / equivalent prov)
  aadt_medium: number    // light trucks + buses
  aadt_heavy: number     // heavy trucks (no trailer + with trailer)
  aadt_moto: number      // motorcycles
}

// ── Step 1: download cached files if missing ──

async function downloadFile(url: string, path: string, label: string): Promise<void> {
  if (!forceDownload && existsSync(path)) {
    console.log(`  Using cached ${label}: ${path}`)
    return
  }
  if (enrichOnly) throw new Error(`--enrich-only but ${label} not cached`)
  console.log(`  Downloading ${label}...`)
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${label} (${url})`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(path, buf)
  console.log(`  Cached: ${(buf.length / 1e6).toFixed(2)} MB`)
}

async function downloadAll(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true })
  await downloadFile(NATIONAL_XLS_URL, CACHE_NATIONAL_XLS, 'GPR national XLS')
  await downloadFile(PROVINCIAL_XLS_URL, CACHE_PROVINCIAL_XLS, 'GPR provincial XLS')
  await downloadFile(SHP_ZIP_URL, CACHE_SHP_ZIP, 'GPR national SHP zip')
}

// ── Step 2: parse XLS ──

interface XlsRecord {
  nr2020: string
  ref: string
  pikp: number
  pikk: number
  imdTot: number
  motorcycles: number
  cars: number
  lightTrucks: number
  trucksNoTrailer: number
  trucksWithTrailer: number
  buses: number
}

function parseGprXls(path: string, label: string): Map<string, XlsRecord> {
  const buf = readFileSync(path)
  const wb = XLSX.read(buf, { type: 'buffer' })
  const sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'tab02') || wb.SheetNames[0]
  const sheet = wb.Sheets[sheetName]
  const range = XLSX.utils.decode_range(sheet['!ref']!)

  // Find data start (first row where col 0 is a number)
  let dataStart = -1
  for (let r = 0; r <= Math.min(30, range.e.r); r++) {
    const cell = sheet[XLSX.utils.encode_cell({ r, c: 0 })]
    if (cell && typeof cell.v === 'number') { dataStart = r; break }
  }
  if (dataStart < 0) throw new Error(`${label}: could not find data start row`)

  // Column layout (verified from XLS inspection):
  // 0=Numer punktu (nr2020), 1=NrDrogi (road), 2=E (Euro route),
  // 3=Pikietaż pocz., 4=Pikietaż końc., 5=Długość, 6=Nazwa,
  // 7=SDRR poj./dobę (TOTAL), 8=Motocykle, 9=Sam. osob.+mikro,
  // 10=Lekkie sam. ciężar., 11=Sam. cięż. bez przycz., 12=Sam. cięż. z przycz.,
  // 13=Autobusy, 14=Ciągniki

  const map = new Map<string, XlsRecord>()
  for (let r = dataStart; r <= range.e.r; r++) {
    const get = (c: number) => sheet[XLSX.utils.encode_cell({ r, c })]?.v
    const num = (c: number) => {
      const v = get(c)
      if (typeof v === 'number') return v
      if (typeof v === 'string') {
        const cleaned = v.replace(',', '.').replace(/\s/g, '')
        if (cleaned === '-' || cleaned === '') return 0
        const n = parseFloat(cleaned)
        return isNaN(n) ? 0 : n
      }
      return 0
    }
    const id = get(0)
    const road = get(1)
    if (id == null || road == null) continue

    const nr2020 = id.toString().trim()
    const refRaw = road.toString().trim()
    if (!nr2020 || !refRaw) continue

    // Normalize: "A 1" → "A1", "DK 7" → "DK7", "85" → "DK85" (national defaults to DK)
    let ref = refRaw.replace(/\s+/g, '').toUpperCase()
    // Provincial roads use "DW" prefix, national might be just number
    if (/^\d/.test(ref)) {
      // Pure digit means national or provincial; we use NR2020 prefix to disambiguate later
      ref = ref
    }

    map.set(nr2020, {
      nr2020,
      ref,
      pikp: num(3),
      pikk: num(4),
      imdTot: num(7),
      motorcycles: num(8),
      cars: num(9),
      lightTrucks: num(10),
      trucksNoTrailer: num(11),
      trucksWithTrailer: num(12),
      buses: num(13),
    })
  }

  console.log(`  ${label}: parsed ${map.size} measurement points`)
  return map
}

// ── Step 3: load SHP and join with XLS ──

async function buildSegments(): Promise<SegmentRecord[]> {
  if (!forceDownload && existsSync(CACHE_PARSED)) {
    console.log(`  Using cached parsed segments: ${CACHE_PARSED}`)
    return JSON.parse(readFileSync(CACHE_PARSED, 'utf-8'))
  }

  console.log(`  Loading national SHP via shpjs...`)
  const shpBuf = readFileSync(CACHE_SHP_ZIP)
  const result = await shp(shpBuf)
  const fc = Array.isArray(result) ? result[0] : result
  console.log(`  SHP features: ${fc.features.length}`)

  console.log(`  Parsing national XLS...`)
  const nationalXls = parseGprXls(CACHE_NATIONAL_XLS, 'national')

  console.log(`  Parsing provincial XLS...`)
  const provincialXls = parseGprXls(CACHE_PROVINCIAL_XLS, 'provincial')

  const segments: SegmentRecord[] = []
  let nationalMatched = 0
  let nationalUnmatched = 0

  // National roads: join SHP geometry with XLS via NR2020
  for (const feat of fc.features) {
    const props = feat.properties || {}
    const nr2020 = (props.NR2020 || '').toString().trim()
    const xls = nationalXls.get(nr2020)
    if (!xls) {
      // Fall back to SDRR field in DBF (total only, no class split)
      const sdrr = parseFloat(props.SDRR || '0')
      if (sdrr > 0) {
        const coords = extractCentroid(feat.geometry)
        if (coords) {
          const refRaw = (props.NRDROGI || '').toString().trim().toUpperCase().replace(/\s+/g, '')
          const ref = /^[AS]/.test(refRaw) ? refRaw : `DK${refRaw}`
          // Synthetic class split using CNOSSOS defaults
          segments.push(makeFromTotal(nr2020, ref, coords[0], coords[1], sdrr, false))
          nationalUnmatched++
        }
      }
      continue
    }

    const coords = extractCentroid(feat.geometry)
    if (!coords) { nationalUnmatched++; continue }

    // Determine ref prefix from SHP NRDROGI
    const refRaw = (props.NRDROGI || '').toString().trim().toUpperCase().replace(/\s+/g, '')
    let ref: string
    if (/^[AS]/.test(refRaw)) {
      ref = refRaw // motorways A1/S7 keep prefix
    } else if (/^\d/.test(refRaw)) {
      ref = `DK${refRaw}` // national road number prefixed
    } else {
      ref = refRaw
    }

    segments.push(makeRecord(nr2020, ref, coords[0], coords[1], xls, false))
    nationalMatched++
  }

  console.log(`  National: ${nationalMatched} matched (XLS), ${nationalUnmatched} unmatched (SDRR-only fallback)`)

  // Provincial roads: NO geometry — emit records with empty coords for ref-only matching
  // We use a sentinel midLat=0/midLon=0 and rely on ref + OSM proximity (but here we need a position)
  // Strategy: skip provincial without coords; OSM ref-matching handles them by ref alone if midLat=NaN
  // For practical match, we use OSM-side approach: index OSM segments by ref, then for each provincial XLS
  // record, find any OSM segment with that ref and apply (lower priority than national).
  // To keep this script simple, we add provincial records with sentinel coordinates and match via ref.
  let provincialAdded = 0
  for (const xls of provincialXls.values()) {
    // Provincial refs need DW prefix
    const refClean = xls.ref.replace(/^DW/, '').replace(/[^0-9A-Z]/g, '')
    const ref = `DW${refClean}`
    segments.push(makeRecord(xls.nr2020, ref, NaN, NaN, xls, true))
    provincialAdded++
  }
  console.log(`  Provincial: ${provincialAdded} added (no geometry, ref-only matching)`)

  writeFileSync(CACHE_PARSED, JSON.stringify(segments))
  console.log(`  Cached ${segments.length} segments to ${CACHE_PARSED}`)
  return segments
}

function extractCentroid(geom: any): [number, number] | null {
  if (!geom || !geom.coordinates) return null
  const coords = geom.coordinates
  let sumLon = 0, sumLat = 0, n = 0
  if (geom.type === 'LineString') {
    for (const [lon, lat] of coords) { sumLon += lon; sumLat += lat; n++ }
  } else if (geom.type === 'MultiLineString') {
    for (const line of coords) {
      for (const [lon, lat] of line) { sumLon += lon; sumLat += lat; n++ }
    }
  } else return null
  if (n === 0) return null
  return [sumLat / n, sumLon / n]
}

function makeRecord(nr2020: string, ref: string, lat: number, lon: number, xls: XlsRecord, isProvincial: boolean): SegmentRecord {
  // CNOSSOS-EU vehicle classes:
  //   light = cars
  //   medium = light trucks + buses
  //   heavy = trucks_no_trailer + trucks_with_trailer
  //   moto = motorcycles
  const aadt_light = Math.round(xls.cars)
  const aadt_medium = Math.round(xls.lightTrucks + xls.buses)
  const aadt_heavy = Math.round(xls.trucksNoTrailer + xls.trucksWithTrailer)
  const aadt_moto = Math.round(xls.motorcycles)
  return {
    nr2020,
    ref,
    isProvincial,
    midLat: lat,
    midLon: lon,
    imdTot: xls.imdTot,
    aadt_light,
    aadt_medium,
    aadt_heavy,
    aadt_moto,
  }
}

function makeFromTotal(nr2020: string, ref: string, lat: number, lon: number, total: number, isProvincial: boolean): SegmentRecord {
  // CNOSSOS default split for Polish motorways/national roads when only SDRR is known:
  // light=72%, medium=8%, heavy=18%, moto=2%
  const aadt_moto = Math.round(total * 0.02)
  const aadt_medium = Math.round(total * 0.08)
  const aadt_heavy = Math.round(total * 0.18)
  const aadt_light = Math.round(total - aadt_moto - aadt_medium - aadt_heavy)
  return {
    nr2020,
    ref,
    isProvincial,
    midLat: lat,
    midLon: lon,
    imdTot: total,
    aadt_light,
    aadt_medium,
    aadt_heavy,
    aadt_moto,
  }
}

// ── Step 4: enrich roads.arrow ──

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function enrichArrows(segments: SegmentRecord[]): Promise<void> {
  // Index by ref
  const refIndex = new Map<string, SegmentRecord[]>()
  for (const s of segments) {
    if (!refIndex.has(s.ref)) refIndex.set(s.ref, [])
    refIndex.get(s.ref)!.push(s)
  }
  console.log(`\n  Ref index: ${refIndex.size} unique refs`)

  // Pre-filter Polish hexes
  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (lat >= PL_BBOX[0] && lat <= PL_BBOX[2] && lon >= PL_BBOX[1] && lon <= PL_BBOX[3]) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  Polish hexes with roads.arrow: ${hexDirs.length}\n`)

  let totalSeg = 0
  let matched = 0
  let preserved = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const arrowPath = resolve(H3R4_DIR, hex, 'roads.arrow')
    const buf = readFileSync(arrowPath)
    const table = tableFromIPC(buf)
    const numRows = table.numRows
    if (numRows === 0) continue

    const refs = table.getChild('ref')
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

      const osmRefRaw = (refs?.get(i)?.toString() || '').trim().toUpperCase()
      // Polish OSM refs: "A1", "S7", "DK 1", "DW 806", "85"
      // Try several normalizations, take first ref if multi (";"-separated)
      const firstRef = osmRefRaw.split(';')[0].replace(/\s+/g, '')
      const candidates: string[] = [firstRef]
      // If pure number, also try DK prefix
      if (/^\d+$/.test(firstRef)) candidates.push(`DK${firstRef}`, `DW${firstRef}`)

      let best: SegmentRecord | null = null
      let bestDist = Infinity

      for (const cand of candidates) {
        if (!refIndex.has(cand)) continue
        for (const s of refIndex.get(cand)!) {
          if (Number.isNaN(s.midLat)) {
            // Provincial road without geometry — match by ref alone if no national hit yet
            if (!best || best.isProvincial) {
              best = s
              bestDist = 5_000_000 // sentinel — accepted only if no closer national segment
            }
            continue
          }
          const d = haversineM(midLat, midLon, s.midLat, s.midLon)
          if (d < bestDist) { bestDist = d; best = s }
        }
      }

      // Match within 30km for national, 50km for provincial
      const maxDist = best?.isProvincial ? 50_000 : 30_000
      if (best && (Number.isNaN(best.midLat) || bestDist < maxDist)) {
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

    if (hi % 25 === 0 || hi === hexDirs.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      console.log(`  [${elapsed}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments scanned: ${totalSeg}`)
  console.log(`  Preserved (continental): ${preserved}`)
  console.log(`  Newly matched: ${matched} (${(100 * matched / Math.max(totalSeg, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}/${hexDirs.length}`)

  // Top corridors
  const top = [...segments]
    .filter(s => !Number.isNaN(s.midLat) && s.imdTot > 0)
    .sort((a, b) => b.imdTot - a.imdTot)
    .slice(0, 15)
  console.log(`\n  Top 15 AADT corridors:`)
  for (const s of top) {
    console.log(`    ${s.ref.padEnd(8)} ${s.nr2020}  imdtot=${s.imdTot.toLocaleString().padStart(7)} heavy=${(s.aadt_heavy / s.imdTot * 100).toFixed(1)}%`)
  }
}

// ── Main ──

async function main() {
  console.log(`=== PL Road Traffic Enrichment — GDDKiA GPR 2020/2021 ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache:    ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) throw new Error(`H3R4 directory not found: ${H3R4_DIR}`)

  await downloadAll()
  const segments = await buildSegments()

  // Stats
  const refs = new Set(segments.map(s => s.ref))
  const refPrefixes = new Map<string, number>()
  for (const s of segments) {
    const prefix = s.ref.match(/^[A-Z]+/)?.[0] || '?'
    refPrefixes.set(prefix, (refPrefixes.get(prefix) || 0) + 1)
  }
  console.log(`\n  Total parsed segments: ${segments.length}`)
  console.log(`  Unique refs: ${refs.size}`)
  console.log(`  Ref prefix distribution:`)
  for (const [p, n] of [...refPrefixes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${p}: ${n}`)
  }

  await enrichArrows(segments)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
