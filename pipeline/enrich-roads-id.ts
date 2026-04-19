/**
 * Enrich ID roads.arrow with Bina Marga (Directorate General of Highways)
 * GIS portal — the first real per-segment AADT dataset found for any non-EU
 * Asian country outside the Thailand DRR.
 *
 * **The critical find**: `gisportal.binamarga.pu.go.id` is a publicly accessible
 * ArcGIS Server that exposes the Indonesian national + regional road network
 * with per-segment **LHRT** (Lalu Lintas Harian Rata-rata = AADT equivalent),
 * VCR (volume-to-capacity ratio), road class, road function, and pavement
 * type. No auth, no geofence, WGS84 output.
 *
 * ## Sources
 *
 * 1. **Regional Roads with LHRT** (`Jalan/Jalan_Daerah`)
 *    - URL: `https://gisportal.binamarga.pu.go.id/arcgis/rest/services/Jalan/Jalan_Daerah/MapServer/0`
 *    - **27,127 polyline segments**, **17,198 with LHRT > 0**
 *    - Coverage: Provincial + Regency + City roads (Jalan Provinsi / Jalan
 *      Kabupaten / Jalan Kota)
 *    - Key fields: `LHRT` (AADT, double), `VCR`, `STATUS`, `FUNGSI`,
 *      `TIPE_JLN` (road type), `LBR_KERAS` (paved width), `PROVINSI`, `NM_RUAS`,
 *      `KELAS_JALAN`, `PANJANG`
 *    - LHRT range: median 300 veh/day, p95 18,661 veh/day, max 854,100 (clipped
 *      to 200,000 as outlier cap — likely annual total not daily)
 *
 * 2. **National Roads** (`Jalan/Road_Network_National`)
 *    - URL: `https://gisportal.binamarga.pu.go.id/arcgis/rest/services/Jalan/Road_Network_National/MapServer/0`
 *    - 1,000 polyline segments (of 3,983 total — partial download due to
 *      ArcGIS 500 errors beyond offset 1000)
 *    - Fields: ROAD_FUNCTION (A=arterial/K=collector), ROAD_STATUS (N=national),
 *      ROAD_CLASS, LINK_NAME, LINK_ID
 *    - **No LHRT here** — apply class-based defaults
 *
 * 3. **Toll Roads** (`Tol/Jalan_Tol_Operasi`)
 *    - URL: `https://gisportal.binamarga.pu.go.id/arcgis/rest/services/Tol/Jalan_Tol_Operasi/MapServer/0`
 *    - 158 operating segments with NAMA_TOL, PENGELOLA (operator), PROVINSI
 *    - Trans-Java Toll + JORR + Jakarta-Cikampek + Trans-Sumatra + others
 *    - Apply expressway default (very high AADT)
 *
 * ## Matching strategy
 *
 * 1. **Tier 1 — Regional roads spatial match**: find nearest Jalan_Daerah
 *    polyline within 200m. If LHRT > 0, use directly. If LHRT = 0, use
 *    STATUS-based default.
 * 2. **Tier 2 — Toll roads spatial match**: find nearest toll polyline within
 *    300m. Apply expressway default (80,000 × tier mult).
 * 3. **Tier 3 — National roads spatial match**: find nearest national polyline
 *    within 400m. Apply ROAD_CLASS-based default (class I → 40k, II → 25k,
 *    III → 12k).
 * 4. **Tier 4 — Indonesian CNOSSOS class defaults** for unmatched segments.
 *
 * Only apply spatial match for OSM class ≤ 2 (motorway/trunk/primary) for
 * performance.
 *
 * ## Indonesian vehicle split
 *
 * Indonesia has the HIGHEST motorcycle share in this pipeline: 60% urban
 * (Jakarta Tier-1), 50% Tier-2, 35% rural. Heavy trucks restricted in cities.
 *
 *   Tier-1 (Jabodetabek, Surabaya, Bandung, etc.):
 *     light 30% / medium 5% / heavy 5% / moto 60%
 *   Tier-2:
 *     light 40% / medium 6% / heavy 4% / moto 50%
 *   Rural:
 *     light 50% / medium 8% / heavy 7% / moto 35%
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-id.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('id-national-roads')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/id`)

// ID bbox (archipelago: Sumatra + Java + Bali + Borneo + Sulawesi + Papua)
const ID_BBOX: [number, number, number, number] = [-11.5, 94.0, 6.5, 141.5]

// Exclusion zones for neighbours
const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  // Malaysia (peninsular + Sabah/Sarawak on Borneo)
  { name: 'Malaysia-Peninsular', bbox: [1.0, 99.5, 6.5, 104.5] },
  { name: 'Malaysia-Sabah-Sarawak', bbox: [0.9, 109.5, 7.5, 119.5] },
  // Singapore
  { name: 'Singapore', bbox: [1.1, 103.5, 1.6, 104.2] },
  // Brunei
  { name: 'Brunei', bbox: [4.0, 114.0, 5.1, 115.4] },
  // Philippines
  { name: 'Philippines', bbox: [4.5, 116.9, 20.0, 127.0] },
  // Timor-Leste
  { name: 'Timor-Leste', bbox: [-9.5, 124.0, -8.1, 127.3] },
  // Papua New Guinea
  { name: 'PNG', bbox: [-11.0, 140.8, -1.0, 155.0] },
]

// Tier-1 Indonesian metros (Jabodetabek + Big 5)
const TIER1_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  // Jabodetabek = Jakarta Metropolitan Area (includes Bogor, Depok, Tangerang, Bekasi)
  { name: 'Jakarta (Jabodetabek)', bbox: [-6.5, 106.4, -6.0, 107.1] },
  { name: 'Surabaya (Gerbangkertosusila)', bbox: [-7.4, 112.5, -7.1, 112.9] },
  { name: 'Bandung (Bandung Raya)', bbox: [-7.1, 107.5, -6.8, 107.8] },
  { name: 'Medan (Mebidang)', bbox: [3.45, 98.55, 3.75, 98.85] },
  { name: 'Semarang', bbox: [-7.05, 110.3, -6.8, 110.55] },
  { name: 'Makassar', bbox: [-5.25, 119.3, -5.05, 119.55] },
  { name: 'Palembang', bbox: [-3.1, 104.6, -2.85, 104.85] },
  { name: 'Denpasar (Sarbagita Bali)', bbox: [-8.85, 115.1, -8.55, 115.35] },
]

// Tier-2 Indonesian cities
const TIER2_CITIES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Yogyakarta', bbox: [-7.88, 110.3, -7.72, 110.45] },
  { name: 'Malang', bbox: [-8.05, 112.55, -7.9, 112.7] },
  { name: 'Padang', bbox: [-1.0, 100.28, -0.85, 100.42] },
  { name: 'Pekanbaru', bbox: [0.45, 101.35, 0.6, 101.55] },
  { name: 'Jambi', bbox: [-1.7, 103.55, -1.55, 103.7] },
  { name: 'Bengkulu', bbox: [-3.85, 102.25, -3.7, 102.4] },
  { name: 'Bandar Lampung', bbox: [-5.5, 105.2, -5.3, 105.4] },
  { name: 'Serang', bbox: [-6.15, 106.1, -6.0, 106.25] },
  { name: 'Banjarmasin', bbox: [-3.4, 114.55, -3.25, 114.7] },
  { name: 'Balikpapan', bbox: [-1.3, 116.75, -1.15, 116.95] },
  { name: 'Samarinda', bbox: [-0.55, 117.1, -0.4, 117.25] },
  { name: 'Pontianak', bbox: [-0.1, 109.3, 0.05, 109.4] },
  { name: 'Palangkaraya', bbox: [-2.25, 113.85, -2.1, 114.0] },
  { name: 'Mataram (Lombok)', bbox: [-8.65, 116.05, -8.5, 116.2] },
  { name: 'Kupang (Timor)', bbox: [-10.25, 123.55, -10.1, 123.7] },
  { name: 'Manado', bbox: [1.45, 124.78, 1.58, 124.92] },
  { name: 'Gorontalo', bbox: [0.5, 123.02, 0.62, 123.1] },
  { name: 'Kendari', bbox: [-4.05, 122.5, -3.9, 122.65] },
  { name: 'Palu', bbox: [-0.95, 119.85, -0.8, 120.0] },
  { name: 'Ambon', bbox: [-3.75, 128.15, -3.65, 128.25] },
  { name: 'Jayapura', bbox: [-2.6, 140.65, -2.5, 140.8] },
  { name: 'Ternate', bbox: [0.75, 127.3, 0.85, 127.4] },
  { name: 'Cirebon', bbox: [-6.78, 108.5, -6.68, 108.6] },
  { name: 'Tasikmalaya', bbox: [-7.35, 108.18, -7.25, 108.28] },
  { name: 'Sukabumi', bbox: [-6.98, 106.88, -6.88, 107.0] },
  { name: 'Pekalongan', bbox: [-6.95, 109.63, -6.85, 109.73] },
  { name: 'Tegal', bbox: [-6.9, 109.1, -6.8, 109.2] },
  { name: 'Solo (Surakarta)', bbox: [-7.6, 110.78, -7.5, 110.88] },
  { name: 'Magelang', bbox: [-7.52, 110.18, -7.42, 110.28] },
  { name: 'Madiun', bbox: [-7.68, 111.48, -7.58, 111.58] },
  { name: 'Kediri', bbox: [-7.85, 112.0, -7.75, 112.1] },
  { name: 'Probolinggo', bbox: [-7.78, 113.18, -7.68, 113.28] },
  { name: 'Pasuruan', bbox: [-7.68, 112.88, -7.58, 112.98] },
]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyZone(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}
function cityTier(lat: number, lon: number): 0 | 1 | 2 {
  for (const c of TIER1_CITIES) if (inBbox(lat, lon, c.bbox)) return 1
  for (const c of TIER2_CITIES) if (inBbox(lat, lon, c.bbox)) return 2
  return 0
}

// ── Geometry ──
function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos((lat1 + lat2) / 2 * Math.PI / 180)
  const dx = (lon2 - lon1) * 111320 * cosLat
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}
function pointToSegmentDist(pLat: number, pLon: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cosLat = Math.cos(pLat * Math.PI / 180)
  const px = pLon * 111320 * cosLat, py = pLat * 110540
  const ax = aLon * 111320 * cosLat, ay = aLat * 110540
  const bx = bLon * 111320 * cosLat, by = bLat * 110540
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return flatDist(pLat, pLon, aLat, aLon)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
}
function pointToPolylineDist(pLat: number, pLon: number, coords: [number, number][]): number {
  let best = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentDist(pLat, pLon, coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0])
    if (d < best) best = d
  }
  return best
}

interface RoadFeat {
  coords: [number, number][]
  source: 'regional' | 'national' | 'toll'
  lhrt: number    // 0 if unknown
  status: string
  fungsi: string
}

function loadFeats(path: string, source: 'regional' | 'national' | 'toll'): RoadFeat[] {
  if (!existsSync(path)) return []
  const fc = JSON.parse(readFileSync(path, 'utf-8'))
  const out: RoadFeat[] = []
  for (const f of fc.features || []) {
    const g = f.geometry
    if (!g) continue
    let coords: [number, number][] = []
    if (g.type === 'LineString') coords = g.coordinates
    else if (g.type === 'MultiLineString') {
      for (const part of g.coordinates) coords.push(...part)
    }
    if (coords.length < 2) continue
    const p = f.properties || {}
    out.push({
      coords,
      source,
      lhrt: Math.min(+(p.LHRT || 0), 200000),  // clip outliers
      status: (p.STATUS || p.ROAD_STATUS || '').toString().trim(),
      fungsi: (p.FUNGSI || p.ROAD_FUNCTION || p.ROAD_CLASS || '').toString().trim(),
    })
  }
  return out
}

function buildGrid(features: RoadFeat[]): Map<string, RoadFeat[]> {
  const grid = new Map<string, RoadFeat[]>()
  for (const feat of features) {
    const seen = new Set<string>()
    for (const [lon, lat] of feat.coords) {
      const key = `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`
      if (!seen.has(key)) {
        seen.add(key)
        if (!grid.has(key)) grid.set(key, [])
        grid.get(key)!.push(feat)
      }
    }
  }
  return grid
}

function nearest(midLat: number, midLon: number, grid: Map<string, RoadFeat[]>, radiusM: number): { feat: RoadFeat; dist: number } | null {
  const reach = Math.max(1, Math.ceil(radiusM / 1000))
  const baseLat = Math.floor(midLat * 100)
  const baseLon = Math.floor(midLon * 100)
  let best: RoadFeat | null = null
  let bestDist = radiusM
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const cell = grid.get(`${baseLat + dy}_${baseLon + dx}`)
      if (!cell) continue
      for (const feat of cell) {
        const d = pointToPolylineDist(midLat, midLon, feat.coords)
        if (d < bestDist) { bestDist = d; best = feat }
      }
    }
  }
  return best ? { feat: best, dist: bestDist } : null
}

// Indonesian class defaults (fallback)
const CLASS_AADT: Record<number, number> = {
  0: 50000, 1: 20000, 2: 10000, 3: 4000, 4: 1500, 5: 800, 6: 300,
}

function tierMultiplier(tier: 0 | 1 | 2): number {
  return tier === 1 ? 2.0 : tier === 2 ? 1.4 : 1.0
}

function splitVehicles(aadt: number, tier: 0 | 1 | 2): { light: number; medium: number; heavy: number; moto: number } {
  if (tier === 1) {
    // Jakarta/Surabaya/etc: 60% motorcycles
    return {
      light: Math.round(aadt * 0.30),
      medium: Math.round(aadt * 0.05),
      heavy: Math.round(aadt * 0.05),
      moto: Math.round(aadt * 0.60),
    }
  }
  if (tier === 2) {
    return {
      light: Math.round(aadt * 0.40),
      medium: Math.round(aadt * 0.06),
      heavy: Math.round(aadt * 0.04),
      moto: Math.round(aadt * 0.50),
    }
  }
  return {
    light: Math.round(aadt * 0.50),
    medium: Math.round(aadt * 0.08),
    heavy: Math.round(aadt * 0.07),
    moto: Math.round(aadt * 0.35),
  }
}

async function main() {
  console.log(`=== ID Roads Enrichment — Bina Marga LHRT + Indonesian-tuned CNOSSOS (${YEAR}) ===\n`)

  const regional = loadFeats(resolve(CACHE_DIR, 'roads-regional-lhrt.geojson'), 'regional')
  const national = loadFeats(resolve(CACHE_DIR, 'roads-national.geojson'), 'national')
  const toll = loadFeats(resolve(CACHE_DIR, 'roads-toll.geojson'), 'toll')
  console.log(`  Regional roads: ${regional.length} (with LHRT>0: ${regional.filter(r => r.lhrt > 0).length})`)
  console.log(`  National roads: ${national.length}`)
  console.log(`  Toll roads:     ${toll.length}`)

  const regionalGrid = buildGrid(regional)
  const nationalGrid = buildGrid(national)
  const tollGrid = buildGrid(toll)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, ID_BBOX)) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`\n  ID-bbox hexes with roads.arrow: ${hexDirs.length}`)

  let totalRoads = 0, excluded = 0, alreadyEnriched = 0
  let matchedLHRT = 0, matchedRegionalDefault = 0, matchedToll = 0, matchedNational = 0, matchedClass = 0
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
    const roadClass = table.getChild('road_class')!

    const existingSource = table.getChild('traffic_source')
    const existingDatasetId = table.getChild('roads_dataset_id')
    const existingLight = table.getChild('aadt_light')
    const existingMed = table.getChild('aadt_medium')
    const existingHvy = table.getChild('aadt_heavy')
    const existingMoto = table.getChild('aadt_moto')

    const trafficSource = new Uint8Array(n)
    const datasetId = new Uint16Array(n)
    const aadtLight = new Int32Array(n)
    const aadtMedium = new Int32Array(n)
    const aadtHeavy = new Int32Array(n)
    const aadtMoto = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      trafficSource[i] = (existingSource?.get(i) as number) ?? 0
      datasetId[i] = existingDatasetId ? (existingDatasetId.get(i) as number) ?? 0 : 0
      aadtLight[i] = (existingLight?.get(i) as number) ?? 0
      aadtMedium[i] = (existingMed?.get(i) as number) ?? 0
      aadtHeavy[i] = (existingHvy?.get(i) as number) ?? 0
      aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
    }

    totalRoads += n
    let hexMatched = 0

    for (let i = 0; i < n; i++) {
      if (!shouldOverwrite(datasetId[i], MY_DATASET_ID)) { alreadyEnriched++; continue }

      const sLat = startLat.get(i) as number
      const sLon = startLon.get(i) as number
      const eLat = endLat.get(i) as number
      const eLon = endLon.get(i) as number
      const midLat = (sLat + eLat) / 2
      const midLon = (sLon + eLon) / 2

      if (!inBbox(midLat, midLon, ID_BBOX)) continue
      if (inAnyZone(midLat, midLon)) { excluded++; continue }

      const tier = cityTier(midLat, midLon)
      const mult = tierMultiplier(tier)
      const cls = (roadClass.get(i) as number) ?? 5

      let aadt = 0
      let source: 'lhrt' | 'regional' | 'national' | 'toll' | 'class' | null = null

      // Try spatial match only for higher-class roads (class ≤ 2)
      if (cls <= 2) {
        // Tier A: Toll roads (highest priority, highest AADT)
        const tollNear = nearest(midLat, midLon, tollGrid, 300)
        if (tollNear) {
          aadt = 80000 * mult  // Indonesian toll road default
          source = 'toll'
          matchedToll++
        }

        // Tier B: Regional roads (LHRT — real AADT)
        if (!source) {
          const regNear = nearest(midLat, midLon, regionalGrid, 200)
          if (regNear) {
            if (regNear.feat.lhrt > 0) {
              aadt = regNear.feat.lhrt  // already calibrated; tier multiplier NOT applied
              source = 'lhrt'
              matchedLHRT++
            } else {
              // Use STATUS-based default for regional without LHRT
              const status = regNear.feat.status.toLowerCase()
              let baseAadt = 5000
              if (status.includes('kota')) baseAadt = 12000
              else if (status.includes('provinsi')) baseAadt = 8000
              aadt = baseAadt * mult
              source = 'regional'
              matchedRegionalDefault++
            }
          }
        }

        // Tier C: National roads (class-based default)
        if (!source) {
          const natNear = nearest(midLat, midLon, nationalGrid, 400)
          if (natNear) {
            aadt = 30000 * mult  // national arterial default
            source = 'national'
            matchedNational++
          }
        }
      }

      // Tier D: CNOSSOS class defaults
      if (!source) {
        aadt = (CLASS_AADT[cls] ?? 800) * mult
        source = 'class'
        matchedClass++
      }

      const split = splitVehicles(aadt, tier)
      aadtLight[i] = split.light
      aadtMedium[i] = split.medium
      aadtHeavy[i] = split.heavy
      aadtMoto[i] = split.moto
      trafficSource[i] = 1
      datasetId[i] = MY_DATASET_ID
      hexMatched++
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['traffic_source', 'aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'roads_dataset_id'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['traffic_source'] = vectorFromArray(trafficSource, new Uint8())

      columns['roads_dataset_id'] = vectorFromArray(datasetId, new Uint16())
      columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
      columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
      columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
      columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())

      const newTable = makeTable(columns)
      writeFileSync(roadPath, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }

    const elapsed = Date.now() - startTime
    if (elapsed > 10_000 && hi % 50 === 0) {
      console.log(`  [${(elapsed / 1000).toFixed(0)}s] ${hi + 1}/${hexDirs.length}, ${matchedLHRT} LHRT + ${matchedClass} class`)
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total roads scanned:        ${totalRoads.toLocaleString()}`)
  console.log(`  Already enriched (skip):    ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):      ${excluded.toLocaleString()}`)
  console.log(`  Matched by Bina Marga LHRT: ${matchedLHRT.toLocaleString()}  (REAL AADT)`)
  console.log(`  Matched by Bina Marga toll: ${matchedToll.toLocaleString()}`)
  console.log(`  Matched by regional default: ${matchedRegionalDefault.toLocaleString()}`)
  console.log(`  Matched by national class:   ${matchedNational.toLocaleString()}`)
  console.log(`  Matched by CNOSSOS class:    ${matchedClass.toLocaleString()}`)
  const tot = matchedLHRT + matchedToll + matchedRegionalDefault + matchedNational + matchedClass
  console.log(`  Total enriched:              ${tot.toLocaleString()} (${(100 * tot / Math.max(totalRoads, 1)).toFixed(2)}%)`)
  console.log(`  Hexes updated:               ${hexesUpdated}/${hexDirs.length}`)
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
