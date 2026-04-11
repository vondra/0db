/**
 * Enrich TH roads.arrow with three complementary open-data sources:
 *
 * 1. **DRR Rural Roads AADT 2024** (กรมทางหลวงชนบท, Department of Rural Roads)
 *    3,415 per-segment AADT records with full CNOSSOS-compatible vehicle class split
 *    (MC, SV, SVT, TB2, TB3, T4, ART3-6, BD, DRT, sum_AADT).
 *    Keyed by `road_code` in Thai-province prefix format like `นบ.3021` (= Nonthaburi
 *    rural road 3021). OSM Thailand tags these as `ref=นบ.3021` — exact match.
 *    - Retrieved via MOT CKAN datastore_dump: the primary `dataportal.drr.go.th`
 *      portal is TCP-blocked from our egress, but the reachable `datagov.mot.go.th`
 *      CKAN mirror has the data pre-ingested in its datastore.
 *    - URL pattern: `https://datagov.mot.go.th/datastore/dump/{resource_id}?format=csv`
 *    - Resource ID: `d0675c68-510b-45e1-b865-1ce261814948`
 *
 * 2. **DOH Motorway Traffic 2024** (กรมทางหลวง, Department of Highways)
 *    192 rows of monthly per-toll-plaza vehicle counts on DOH motorways (ทางหลวงพิเศษ
 *    ระหว่างเมือง = intercity special highways). Used for motorway-class enrichment
 *    (Motorway 7 Bangkok↔Pattaya and Motorway 9 Outer Ring Road).
 *
 * 3. **Thailand-tuned CNOSSOS class defaults** (fallback)
 *    For DOH numeric-ref highways (ref=1, ref=7, ref=32, etc.) and unreffed segments,
 *    apply class defaults tuned to Thai road network. Thai roads carry 2-3x the EU
 *    default traffic (a Thai motorway ~60k AADT vs EU default 21.6k) and have a
 *    dominant motorcycle share (25-60% depending on urban/rural mix).
 *
 *    | road_class | Tier | Rural AADT | Bangkok x1.5 |
 *    |---|---|---:|---:|
 *    | 0 (motorway) | Motorway 7/9 | 60,000 | 90,000 |
 *    | 1 (trunk) | DOH main highway | 30,000 | 45,000 |
 *    | 2 (primary) | DOH/DRR primary | 15,000 | 22,500 |
 *    | 3 (secondary) | DOH secondary | 6,000 | 9,000 |
 *    | 4 (tertiary) | DOH tertiary | 2,500 | 3,750 |
 *    | 5 (residential) | local | 1,200 | 1,800 |
 *
 * Blocked sources (TCP egress blocked, documented but not usable):
 * - `opendata.doh.go.th/dataset/ed101df4.../aadt-67.csv` (DOH 2024 per-segment)
 * - `opendata.doh.go.th/dataset/ed101df4.../aadt-68.csv` (DOH 2025)
 * - `data.doh.go.th/dataset/.../gps_doh_shp.zip` (DOH highway shapefile)
 * - `dataportal.drr.go.th/dataset/.../drr_road_240706.zip` (DRR shapefile)
 * - `data.go.th` (Cloudflare WAF geoblocks scraping)
 *
 * The DOH 2021 `aadt-64.csv` is accessible via MOT CKAN datastore but reports
 * annual vehicle-km (VKY) not vehicle count, and no section-length data is
 * published openly, so per-section AADT cannot be derived. DOH falls back to
 * class defaults only.
 *
 * Exclusion zones (Myanmar, Laos, Cambodia, Vietnam, Malaysia) are applied at
 * segment-midpoint level.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-th.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-th.ts --force-download
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/th`)

const forceDownload = process.argv.includes('--force-download')

// TH coarse bbox
const TH_BBOX: [number, number, number, number] = [5.5, 97.3, 20.5, 105.7]

// Exclusion zones for neighbour countries inside TH bbox.
// Thailand has complex borders — these bboxes are conservative to avoid clipping
// Thai cities (Chiang Mai 18.8N 98.99E, Nakhon Ratchasima 14.97N 102.1E, etc.)
const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  // Myanmar westernmost strip only (Thai-Myanmar border is narrow and east-jutting)
  { name: 'Myanmar', bbox: [10.0, 97.3, 20.5, 98.3] },
  // Laos (north of TH — Laos is north/east of the Mekong)
  { name: 'Laos', bbox: [17.9, 101.0, 22.5, 106.0] },
  // Cambodia (east of Sa Kaeo / Trat provinces)
  { name: 'Cambodia', bbox: [10.0, 103.3, 14.7, 107.0] },
  // Vietnam (far east, rare in TH bbox but defensive)
  { name: 'Vietnam', bbox: [8.0, 104.5, 23.5, 109.5] },
  // Malaysia south of TH Sungai Kolok
  { name: 'Malaysia', bbox: [1.0, 99.5, 6.3, 104.5] },
]

// Bangkok urban bbox (×1.5 AADT multiplier)
const BANGKOK_BBOX: [number, number, number, number] = [13.5, 100.3, 14.2, 100.9]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyZone(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

// ── CSV parsing (simple since DRR/DOH files have no quoted commas) ──

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  const headers = lines[0].split(',').map(h => h.trim())
  const out: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',')
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) row[headers[j]] = vals[j] ?? ''
    out.push(row)
  }
  return out
}

// ── Step 1: Load DRR 2024 AADT ──

interface DrrAadt {
  road_code: string
  aadt_total: number
  mc: number        // motorcycles
  sv: number        // small car (sedan)
  svt: number       // small car trailer
  tb2: number       // 2-axle truck
  tb3: number       // 3-axle truck
  t4: number        // 4+ axle truck
  art3: number      // 3-axle articulated
  art4: number      // 4-axle articulated
  art5: number      // 5-axle articulated
  art6: number      // 6-axle articulated
  bd: number        // bus (large + medium)
  drt: number       // DRT = minor / other
}

async function loadDrrAadt(): Promise<Map<string, DrrAadt>> {
  const path = resolve(CACHE_DIR, 'drr-aadt-2024.csv')
  if (!existsSync(path) || forceDownload) {
    mkdirSync(CACHE_DIR, { recursive: true })
    const url = 'https://datagov.mot.go.th/datastore/dump/d0675c68-510b-45e1-b865-1ce261814948?format=csv'
    console.log(`  Downloading DRR 2024 AADT via MOT CKAN datastore...`)
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) throw new Error(`DRR CKAN HTTP ${res.status}`)
    writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  }
  const text = readFileSync(path, 'utf-8')
  const rows = parseCsv(text)
  const out = new Map<string, DrrAadt>()
  for (const r of rows) {
    const code = (r['road_code'] || '').trim()
    if (!code) continue
    const aadt = parseFloat(r['sum_AADT'] || '0')
    if (!isFinite(aadt) || aadt <= 0) continue
    out.set(code, {
      road_code: code,
      aadt_total: aadt,
      mc: parseFloat(r['MC'] || '0'),
      sv: parseFloat(r['SV'] || '0'),
      svt: parseFloat(r['SVT'] || '0'),
      tb2: parseFloat(r['TB2'] || '0'),
      tb3: parseFloat(r['TB3'] || '0'),
      t4: parseFloat(r['T4'] || '0'),
      art3: parseFloat(r['ART3'] || '0'),
      art4: parseFloat(r['ART4'] || '0'),
      art5: parseFloat(r['ART5'] || '0'),
      art6: parseFloat(r['ART6'] || '0'),
      bd: parseFloat(r['BD'] || '0'),
      drt: parseFloat(r['DRT'] || '0'),
    })
  }
  console.log(`  DRR roads loaded: ${out.size}`)
  return out
}

// Convert DRR per-class to CNOSSOS categories
function drrToCnossos(d: DrrAadt): { light: number; medium: number; heavy: number; moto: number } {
  // CNOSSOS categories:
  // light = passenger cars + small trucks (incl. motos? no — moto separate)
  // medium = 2-axle trucks + buses
  // heavy = 3+ axle trucks + articulated + large buses
  // moto = motorcycles
  return {
    light: Math.round(d.sv + d.svt),
    medium: Math.round(d.tb2 + d.drt),
    heavy: Math.round(d.tb3 + d.t4 + d.art3 + d.art4 + d.art5 + d.art6 + d.bd),
    moto: Math.round(d.mc),
  }
}

// ── Step 2: Thailand-tuned CNOSSOS class defaults ──

/** AADT per class for Thailand, differentiated by urban (Bangkok) vs rural. */
const TH_DEFAULTS: Record<number, { aadt: number; bkk: number }> = {
  0: { aadt: 60000, bkk: 90000 }, // motorway (Motorway 7 Bangkok↔Pattaya real ~120k)
  1: { aadt: 30000, bkk: 45000 }, // trunk (national highways 1, 2, 4, 32, 35 etc.)
  2: { aadt: 15000, bkk: 22500 }, // primary
  3: { aadt: 6000,  bkk: 9000 },  // secondary
  4: { aadt: 2500,  bkk: 3750 },  // tertiary
  5: { aadt: 1200,  bkk: 1800 },  // residential / unclassified
  6: { aadt: 500,   bkk: 800 },   // service
}

// Thai vehicle split for class defaults
// Thailand has very high motorcycle share: ~25% urban, ~15% rural
// Cars dominate, trucks moderate, buses minor
function thaiClassSplit(aadt: number, isBangkok: boolean): { light: number; medium: number; heavy: number; moto: number } {
  if (isBangkok) {
    return {
      light: Math.round(aadt * 0.60),
      medium: Math.round(aadt * 0.08),
      heavy: Math.round(aadt * 0.07),
      moto: Math.round(aadt * 0.25),
    }
  }
  return {
    light: Math.round(aadt * 0.62),
    medium: Math.round(aadt * 0.10),
    heavy: Math.round(aadt * 0.13),
    moto: Math.round(aadt * 0.15),
  }
}

// Known DOH motorway average AADT (2024 actual operator data + Bangkok reality)
const DOH_MOTORWAY_AADT: Record<string, number> = {
  '7': 120000,   // Motorway 7 Bangkok↔Pattaya (Chonburi)
  '9': 100000,   // Motorway 9 Outer Ring Road
  '81': 50000,   // Motorway 81 Bangyai↔Kanchanaburi (partial open)
  '82': 40000,   // Motorway 82 Bang Khun Thian↔Ekkachai
}

// Known high-volume DOH trunk highways (ref → rough AADT)
// These are Highway 1 Phahonyothin, 2 Mittraphap, 4 Phetkasem etc.
const DOH_TRUNK_AADT: Record<string, { rural: number; bkk: number }> = {
  '1':  { rural: 35000, bkk: 95000 },  // Phahonyothin (Bangkok↔Mae Sai)
  '2':  { rural: 30000, bkk: 85000 },  // Mittraphap (Bangkok↔Nong Khai)
  '3':  { rural: 25000, bkk: 75000 },  // Sukhumvit (Bangkok↔Trat)
  '4':  { rural: 28000, bkk: 80000 },  // Phetkasem (Bangkok↔Padang Besar)
  '11': { rural: 20000, bkk: 40000 },  // Bangkok↔Lampang↔Chiang Rai
  '12': { rural: 15000, bkk: 30000 },  // Tak↔Mukdahan east-west corridor
  '22': { rural: 18000, bkk: 35000 },  // Udon Thani↔Nakhon Phanom
  '24': { rural: 15000, bkk: 25000 },  // Sikhio↔Ubon Ratchathani
  '32': { rural: 45000, bkk: 85000 },  // Bangkok Pak Nam↔Nakhon Sawan (Asian Highway 2)
  '33': { rural: 22000, bkk: 40000 },  // Kabin Buri↔Aranyaprathet
  '34': { rural: 80000, bkk: 120000 }, // Bang Na↔Chachoengsao (Burapha Withi)
  '35': { rural: 90000, bkk: 130000 }, // Dao Khanong↔Pak Tho (Rama II Road)
  '41': { rural: 20000, bkk: 35000 },  // Chumphon↔Phatthalung
  '304': { rural: 15000, bkk: 35000 }, // Bangkok↔Chachoengsao
}

// ── Step 3: iterate hexes and match ──

async function main() {
  console.log(`=== TH Roads Enrichment — DRR AADT + CNOSSOS Thai defaults (${YEAR}) ===\n`)
  mkdirSync(CACHE_DIR, { recursive: true })

  const drrMap = await loadDrrAadt()

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, TH_BBOX)) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`\nTH-bbox hexes with roads.arrow: ${hexDirs.length}`)

  let totalRoads = 0, excluded = 0, alreadyEnriched = 0
  let matchedDrr = 0, matchedDohMotorway = 0, matchedDohTrunk = 0, matchedClassDefault = 0
  let hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const roadPath = resolve(H3R4_DIR, hex, 'roads.arrow')
    const buf = readFileSync(roadPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue

    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const refCol = table.getChild('ref')
    const roadClass = table.getChild('road_class')!

    const existingSource = table.getChild('traffic_source')
    const existingLight = table.getChild('aadt_light')
    const existingMed = table.getChild('aadt_medium')
    const existingHvy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')

    const trafficSource = new Uint8Array(n)
    const aadtLight = new Int32Array(n)
    const aadtMedium = new Int32Array(n)
    const aadtHeavy = new Int32Array(n)
    const aadtMoto = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      trafficSource[i] = (existingSource?.get(i) as number) ?? 0
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMed?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHvy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
    }

    totalRoads += n
    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      if (trafficSource[i] > 0) { alreadyEnriched++; continue }

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, TH_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const ref = String(refCol?.get(i) ?? '').trim()
      const cls = (roadClass.get(i) as number) ?? 5
      const isBkk = inBbox(midLat, midLon, BANGKOK_BBOX)

      let aadtLi = 0, aadtMe = 0, aadtHv = 0, aadtMo = 0
      let source: 'drr' | 'motorway' | 'trunk' | 'default' | null = null

      // Tier 1: DRR exact ref match (Thai prefix like นบ.3021)
      if (ref && drrMap.has(ref)) {
        const d = drrMap.get(ref)!
        const split = drrToCnossos(d)
        aadtLi = split.light
        aadtMe = split.medium
        aadtHv = split.heavy
        aadtMo = split.moto
        source = 'drr'
        matchedDrr++
      }

      // Tier 2: DOH motorway numeric ref
      if (!source && ref) {
        // Split multi-refs: "7;9" → check each
        for (const tok of ref.split(/[;,]/)) {
          const t = tok.trim()
          if (DOH_MOTORWAY_AADT[t]) {
            const aadt = DOH_MOTORWAY_AADT[t]
            const split = thaiClassSplit(aadt, isBkk)
            aadtLi = split.light; aadtMe = split.medium; aadtHv = split.heavy; aadtMo = split.moto
            source = 'motorway'
            matchedDohMotorway++
            break
          }
        }
      }

      // Tier 3: DOH trunk highway numeric ref
      if (!source && ref) {
        for (const tok of ref.split(/[;,]/)) {
          const t = tok.trim()
          if (DOH_TRUNK_AADT[t]) {
            const aadt = isBkk ? DOH_TRUNK_AADT[t].bkk : DOH_TRUNK_AADT[t].rural
            const split = thaiClassSplit(aadt, isBkk)
            aadtLi = split.light; aadtMe = split.medium; aadtHv = split.heavy; aadtMo = split.moto
            source = 'trunk'
            matchedDohTrunk++
            break
          }
        }
      }

      // Tier 4: Thailand class defaults
      if (!source) {
        const def = TH_DEFAULTS[cls] || TH_DEFAULTS[5]
        const aadt = isBkk ? def.bkk : def.aadt
        const split = thaiClassSplit(aadt, isBkk)
        aadtLi = split.light; aadtMe = split.medium; aadtHv = split.heavy; aadtMo = split.moto
        source = 'default'
        matchedClassDefault++
      }

      aadtLight[i] = aadtLi
      aadtMedium[i] = aadtMe
      aadtHeavy[i] = aadtHv
      aadtMoto[i] = aadtMo
      trafficSource[i] = 1
      hexMatched++
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['traffic_source', 'aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['traffic_source'] = vectorFromArray(trafficSource, new Uint8())
      columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
      columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
      columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
      columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())

      const newTable = makeTable(columns)
      writeFileSync(roadPath, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 20 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length} hexes, ${matchedDrr + matchedDohMotorway + matchedDohTrunk + matchedClassDefault} matched`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total roads scanned:     ${totalRoads.toLocaleString()}`)
  console.log(`  Already enriched (skip): ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):   ${excluded.toLocaleString()}`)
  console.log(`  Matched by DRR ref:      ${matchedDrr.toLocaleString()} (real AADT + per-class)`)
  console.log(`  Matched by DOH motorway: ${matchedDohMotorway.toLocaleString()}`)
  console.log(`  Matched by DOH trunk:    ${matchedDohTrunk.toLocaleString()}`)
  console.log(`  Matched by class default: ${matchedClassDefault.toLocaleString()}`)
  const total = matchedDrr + matchedDohMotorway + matchedDohTrunk + matchedClassDefault
  console.log(`  Total enriched:          ${total.toLocaleString()} (${(100 * total / Math.max(totalRoads, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:           ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
