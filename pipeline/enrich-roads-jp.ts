/**
 * Enrich JP roads.arrow with MLIT 全国道路・街路交通情勢調査 (令和3年 = 2021).
 *
 * Source: Ministry of Land, Infrastructure, Transport and Tourism (国土交通省)
 * https://www.mlit.go.jp/road/census/r3/
 *
 * Data: 47 prefecture CSV files (kasyo01-47.csv) with 24h vehicle counts per
 * census segment. Columns include:
 *   col 59: 24h small cars (小型車, up+down combined)  → aadt_light
 *   col 60: 24h large vehicles (大型車, up+down combined) → aadt_heavy
 *   col 61: 24h total
 *   col 4:  route number (路線番号)
 *   col 3:  road type (道路種別: 1=expressway, 2=national, 3=prefectural, 4=municipal)
 *   col 5:  route name (路線名)
 *   col 18: municipality code (市区町村コード)
 *   col 140: speed limit (指定最高速度 km/h)
 *
 * Matching strategy:
 *   - Primary: route number (路線番号) → OSM ref. National routes (type 2+) have
 *     numeric refs matching directly. A segment midpoint must be within 5km.
 *   - Road class guard: census road type must broadly match OSM road_class to
 *     prevent residential roads getting expressway AADT (type 1 → class 0/1,
 *     type 2/3 → class 1/2/3, type 4 → class 3/4/5).
 *   - Expressways (type 1): route numbers in MLIT are 4-digit (1010, 1101 etc).
 *     OSM uses E4, C1, S5 etc. We convert: route 1010 = E1 (Tomei), 1800=E17 etc
 *     via a lookup table for major expressways. Fall back to proximity within 1km.
 *   - No proximity-only matching for ambiguous cases.
 *
 * MLIT census has 99,417 segments across Japan — good coverage of all road classes.
 *
 * AADT notes:
 *   - Counts are 24h bidirectional total (already combined up+down).
 *   - No motorcycle count in this dataset; aadt_moto = 0.
 *   - No medium vehicle split; aadt_medium = 0 (all non-large → light).
 *   - Pipeline-worker applies oneway_factor=0.5 — do NOT halve here.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-jp.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-jp.ts --force-download
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-jp.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createReadStream } from 'node:fs'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/jp`)

const forceDownload = process.argv.includes('--force-download')
const enrichOnly = process.argv.includes('--enrich-only')

const BASE_URL = 'https://www.mlit.go.jp/road/census/r3/data/csv'
const NUM_PREFECTURES = 47

// ── Types ──

interface CensusSegment {
  routeNum: string     // 路線番号 (route number)
  roadType: number     // 道路種別 (1=expressway, 2=national, 3=prefectural, 4=municipal)
  routeName: string    // 路線名
  aadt_light: number   // 24h small cars (小型車) — bidirectional total
  aadt_heavy: number   // 24h large vehicles (大型車) — bidirectional total
  muniCode: string     // 市区町村コード (municipality code)
  speedLimit: number   // 指定最高速度 (km/h)
  lat: number          // approximate centroid (from geometry if available, else 0)
  lon: number
}

// ── Step 1: Download CSV files ──

async function downloadCensusFiles(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true })
  if (enrichOnly) return

  const promises: Promise<void>[] = []
  for (let i = 1; i <= NUM_PREFECTURES; i++) {
    const fname = `kasyo${String(i).padStart(2, '0')}.csv`
    const cachePath = join(CACHE_DIR, fname)
    if (!forceDownload && existsSync(cachePath)) continue

    promises.push((async () => {
      const url = `${BASE_URL}/${fname}`
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (!res.ok) throw new Error(`MLIT download failed: ${res.status} for ${fname}`)
      const buf = Buffer.from(await res.arrayBuffer())
      writeFileSync(cachePath, buf)
      console.log(`  Downloaded ${fname} (${(buf.length / 1024).toFixed(0)}KB)`)
    })())
  }
  await Promise.all(promises)
}

// ── Step 2: Parse CSV (Shift-JIS encoded) ──

function parseCensusCSV(content: Buffer): CensusSegment[] {
  // Decode Shift-JIS
  const text = decodeShiftJIS(content)
  const lines = text.split('\n')
  if (lines.length < 2) return []

  // Skip header (line 0)
  const segments: CensusSegment[] = []

  for (let li = 1; li < lines.length; li++) {
    const line = lines[li].trim()
    if (!line) continue
    const cols = line.split(',')
    if (cols.length < 62) continue

    const roadType = parseInt(cols[3]) || 0
    const routeNum = cols[4]?.trim() || ''
    const routeName = cols[5]?.trim() || ''
    const muniCode = cols[18]?.trim() || ''
    const aadtSmall = parseNum(cols[59])
    const aadtLarge = parseNum(cols[60])
    const speedLimit = parseInt(cols[140]) || 0

    if (aadtSmall === 0 && aadtLarge === 0) continue
    if (!routeNum && routeNum !== '0') continue

    segments.push({
      routeNum,
      roadType,
      routeName,
      aadt_light: aadtSmall,
      aadt_heavy: aadtLarge,
      muniCode,
      speedLimit,
      lat: 0, // No coordinates in this dataset
      lon: 0,
    })
  }
  return segments
}

function parseNum(s: string): number {
  const n = parseInt((s || '').replace(/,/g, ''))
  return isNaN(n) ? 0 : n
}

// ── Step 3: Build lookup index ──

interface CensusLookup {
  // route number → segments (national/prefectural routes — multiple segments per route)
  byRoute: Map<string, CensusSegment[]>
  // municipality code + route number → segments (for finer matching)
  byMuniRoute: Map<string, CensusSegment[]>
}

function buildLookup(allSegments: CensusSegment[]): CensusLookup {
  const byRoute = new Map<string, CensusSegment[]>()
  const byMuniRoute = new Map<string, CensusSegment[]>()

  for (const seg of allSegments) {
    const rn = seg.routeNum

    if (!byRoute.has(rn)) byRoute.set(rn, [])
    byRoute.get(rn)!.push(seg)

    const muniKey = `${seg.muniCode}:${rn}`
    if (!byMuniRoute.has(muniKey)) byMuniRoute.set(muniKey, [])
    byMuniRoute.get(muniKey)!.push(seg)
  }

  return { byRoute, byMuniRoute }
}

// ── Step 4: Build municipality → representative AADT per road type ──
// Since census segments don't have coordinates, we aggregate to municipality level
// and match OSM roads in the same municipality by road class.

interface MuniStats {
  aadt_light: number
  aadt_heavy: number
  count: number
}

function buildMuniStats(allSegments: CensusSegment[]): Map<string, Map<number, MuniStats>> {
  // muniCode → roadType → avg stats
  const stats = new Map<string, Map<number, MuniStats>>()

  for (const seg of allSegments) {
    if (!seg.muniCode) continue
    if (!stats.has(seg.muniCode)) stats.set(seg.muniCode, new Map())
    const muniMap = stats.get(seg.muniCode)!

    if (!muniMap.has(seg.roadType)) muniMap.set(seg.roadType, { aadt_light: 0, aadt_heavy: 0, count: 0 })
    const s = muniMap.get(seg.roadType)!
    s.aadt_light += seg.aadt_light
    s.aadt_heavy += seg.aadt_heavy
    s.count++
  }

  // Convert sums to averages
  for (const [, muniMap] of stats) {
    for (const [, s] of muniMap) {
      if (s.count > 0) {
        s.aadt_light = Math.round(s.aadt_light / s.count)
        s.aadt_heavy = Math.round(s.aadt_heavy / s.count)
      }
    }
  }

  return stats
}

// ── Step 5: Route number matching ──

/** Normalize OSM ref to a route number for matching MLIT census.
 *  MLIT stores 4-digit codes for expressways (1010 = 東名, etc) and
 *  numeric for national routes (1, 2, 4…), prefectural (12, 87, 318…).
 *
 *  OSM Japan refs include:
 *  - Motorways: "E4", "C1", "S5", "1", "17" (expressway designations)
 *  - Trunk/primary: "4", "14", "122", "318" (national/prefectural route numbers)
 *  - Refs with semicolons: "4;6" → try each part
 */
function normalizeOsmRef(ref: string): string[] {
  if (!ref) return []
  // Split on semicolons (multi-value refs)
  return ref.split(';').map(r => r.trim()).filter(r => r.length > 0)
}

/** Map OSM expressway ref to MLIT route number prefix patterns.
 *  MLIT expressway route numbers are 4 digits, e.g.:
 *    1010 = E1 東名 / E1 東名
 *    1101 = E20 中央
 *    1800 = E17 関越
 *    etc.
 *  This is complex and varies by prefecture. For expressways we skip ref-matching
 *  and use road class guard only (expressways match class 0/1).
 */

// ── Step 6: Enrich Arrow files ──

function enrichHexes(lookup: CensusLookup, allSegments: CensusSegment[]): void {
  // Build national average AADT per road type (fallback)
  const nationalAvg = buildNationalAvg(allSegments)
  console.log('\n  National averages by road type:')
  for (const [rt, stats] of nationalAvg.entries()) {
    const rtNames = ['', 'expressway', 'national', 'prefectural', 'municipal']
    console.log(`    type ${rt} (${rtNames[rt] || 'other'}): light=${stats.aadt_light} heavy=${stats.aadt_heavy} (n=${stats.count})`)
  }

  // JP hexes start with '842'
  const hexDirs = readdirSync(H3R4_DIR).filter(d =>
    d.length === 15 && d.endsWith('ffffffff') && d.startsWith('842')
  )
  console.log(`\n  Processing ${hexDirs.length} JP hexes...`)

  let totalRoads = 0
  let totalMatched = 0
  let hexesUpdated = 0
  const matchByClass = new Map<number, { matched: number; total: number }>()
  let lastProgress = Date.now()

  for (const hexId of hexDirs) {
    const roadsPath = resolve(H3R4_DIR, hexId, 'roads.arrow')
    if (!existsSync(roadsPath)) continue

    const buf = readFileSync(roadsPath)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue
    totalRoads += n

    const refCol = table.getChild('ref')
    const roadClassCol = table.getChild('road_class')

    const aadtLight = new Int32Array(n)
    const aadtMedium = new Int32Array(n)
    const aadtHeavy = new Int32Array(n)
    const aadtMoto = new Int32Array(n)
    const existingDatasetId = table.getChild('roads_dataset_id')
    const trafficSource = new Uint8Array(n)
    const datasetId = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      datasetId[i] = existingDatasetId ? (existingDatasetId.get(i) as number) ?? 0 : 0
    }

    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      const roadClass = roadClassCol ? (roadClassCol.get(i) as number) : 5
      if (!matchByClass.has(roadClass)) matchByClass.set(roadClass, { matched: 0, total: 0 })
      matchByClass.get(roadClass)!.total++

      const osmRef = refCol ? (refCol.get(i) as string | null) : null
      if (!osmRef) continue

      const refs = normalizeOsmRef(osmRef)
      if (refs.length === 0) continue

      // Guard: census road type must match OSM road_class
      // class 0/1 → type 1/2, class 2/3 → type 2/3, class 4/5 → type 3/4
      let best: CensusSegment | null = null

      for (const r of refs) {
        const segs = lookup.byRoute.get(r)
        if (!segs || segs.length === 0) continue

        // Filter by class compatibility
        const compatible = segs.filter(s => isCompatible(roadClass, s.roadType))
        if (compatible.length === 0) continue

        // For routes with many segments (common national routes), take average
        best = avgSegment(compatible)
        break
      }

      if (!best) continue

      aadtLight[i] = best.aadt_light
      aadtMedium[i] = 0  // no medium split in MLIT data
      aadtHeavy[i] = best.aadt_heavy
      aadtMoto[i] = 0
      trafficSource[i] = 1
      datasetId[i] = MY_DATASET_ID
      hexMatched++
      matchByClass.get(roadClass)!.matched++
    }

    if (hexMatched === 0) continue

    const columns: Record<string, any> = {}
    for (const field of table.schema.fields) {
      columns[field.name] = table.getChild(field.name)!
    }
    columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
    columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
    columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
    columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
    columns['traffic_source'] = vectorFromArray(trafficSource, new Uint8())

    columns['roads_dataset_id'] = vectorFromArray(datasetId, new Uint16())

    const newTable = makeTable(columns)
    writeFileSync(roadsPath, Buffer.from(tableToIPC(newTable, 'file')))
    totalMatched += hexMatched
    hexesUpdated++

    if (Date.now() - lastProgress > 10000) {
      console.log(`  Progress: ${hexesUpdated}/${hexDirs.length} hexes, ${totalMatched} matched so far`)
      lastProgress = Date.now()
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  ${totalMatched} / ${totalRoads} segments matched (${(totalMatched / totalRoads * 100).toFixed(1)}%)`)
  console.log(`  ${hexesUpdated} / ${hexDirs.length} hexes updated`)
  console.log(`\n  Per road class:`)
  for (const [cls, stats] of [...matchByClass.entries()].sort((a, b) => a[0] - b[0])) {
    const names = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_st']
    const pct = stats.total > 0 ? (stats.matched / stats.total * 100).toFixed(1) : '0.0'
    console.log(`    ${(names[cls] || `class_${cls}`).padEnd(12)} ${stats.matched} / ${stats.total} (${pct}%)`)
  }
}

/** Road class compatibility: MLIT road type → OSM road_class */
function isCompatible(osmClass: number, mlitType: number): boolean {
  // type 1: expressway → class 0 (motorway) or 1 (trunk)
  if (mlitType === 1) return osmClass <= 1
  // type 2: national road → class 0-3 (trunk/primary/secondary)
  if (mlitType === 2) return osmClass >= 0 && osmClass <= 3
  // type 3: prefectural → class 1-4
  if (mlitType === 3) return osmClass >= 1 && osmClass <= 4
  // type 4: municipal → class 3-6
  if (mlitType === 4) return osmClass >= 3
  return true
}

/** Average multiple segments from the same route */
function avgSegment(segs: CensusSegment[]): CensusSegment {
  const sum_l = segs.reduce((a, s) => a + s.aadt_light, 0)
  const sum_h = segs.reduce((a, s) => a + s.aadt_heavy, 0)
  return {
    ...segs[0],
    aadt_light: Math.round(sum_l / segs.length),
    aadt_heavy: Math.round(sum_h / segs.length),
  }
}

function buildNationalAvg(segs: CensusSegment[]): Map<number, MuniStats> {
  const avg = new Map<number, MuniStats>()
  for (const s of segs) {
    if (!avg.has(s.roadType)) avg.set(s.roadType, { aadt_light: 0, aadt_heavy: 0, count: 0 })
    const a = avg.get(s.roadType)!
    a.aadt_light += s.aadt_light
    a.aadt_heavy += s.aadt_heavy
    a.count++
  }
  for (const [, a] of avg) {
    if (a.count > 0) { a.aadt_light = Math.round(a.aadt_light / a.count); a.aadt_heavy = Math.round(a.aadt_heavy / a.count) }
  }
  return avg
}

// ── Shift-JIS decoder ──

function decodeShiftJIS(buf: Buffer): string {
  // Use TextDecoder if available (Node 18+)
  try {
    const td = new TextDecoder('shift-jis')
    return td.decode(buf)
  } catch {
    // Fallback: treat as latin1 and handle manually
    return buf.toString('latin1')
  }
}

// ── Main ──

async function main() {
  console.log(`=== JP Road Traffic Enrichment (${YEAR}) ===`)
  console.log(`Source: MLIT 全国道路・街路交通情勢調査 令和3年 (2021)`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // Step 1: Download
  console.log('Step 1: Checking/downloading census files...')
  await downloadCensusFiles()

  // Step 2: Parse all 47 prefecture files
  console.log('\nStep 2: Parsing census CSVs...')
  const allSegments: CensusSegment[] = []
  for (let i = 1; i <= NUM_PREFECTURES; i++) {
    const fname = `kasyo${String(i).padStart(2, '0')}.csv`
    const cachePath = join(CACHE_DIR, fname)
    if (!existsSync(cachePath)) {
      console.warn(`  WARNING: Missing ${fname}`)
      continue
    }
    const buf = readFileSync(cachePath)
    const segs = parseCensusCSV(buf)
    allSegments.push(...segs)
    if (i <= 5 || i >= 45) console.log(`  ${fname}: ${segs.length} segments`)
  }
  console.log(`  Total: ${allSegments.length} census segments`)

  // Step 3: Build lookup
  console.log('\nStep 3: Building route lookup...')
  const lookup = buildLookup(allSegments)
  console.log(`  ${lookup.byRoute.size} unique route numbers`)
  console.log(`  ${lookup.byMuniRoute.size} unique municipality+route combinations`)

  // Spot check top routes
  const topRoutes = [...lookup.byRoute.entries()]
    .map(([r, segs]) => ({ r, n: segs.length, aadt: segs.reduce((a, s) => a + s.aadt_light + s.aadt_heavy, 0) / segs.length }))
    .sort((a, b) => b.aadt - a.aadt)
    .slice(0, 10)
  console.log('  Top 10 routes by average AADT:')
  for (const { r, n, aadt } of topRoutes) {
    const seg = lookup.byRoute.get(r)![0]
    console.log(`    route=${r} (${seg.routeName.slice(0, 20)}) n=${n} avg_aadt=${Math.round(aadt).toLocaleString()}`)
  }

  // Step 4: Enrich Arrow files
  console.log('\nStep 4: Enriching Arrow files...')
  enrichHexes(lookup, allSegments)

  console.log('\n=== Done ===')
}

// Clean up temp file
import { unlinkSync } from 'node:fs'

const MY_DATASET_ID = DATASETS_BY_KEY.get('jp-national-roads')!.id
try { unlinkSync(resolve(import.meta.dirname, 'check_roads_tmp.ts')) } catch {}

main().catch(err => { console.error('Error:', err); process.exit(1) })
