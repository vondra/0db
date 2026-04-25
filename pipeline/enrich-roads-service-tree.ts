/**
 * Service-tree AADT enrichment for residential roads (v2: flow accumulation).
 *
 * Assigns each building to its nearest eligible segment, then uses multi-source
 * Dijkstra from root nodes (where residential meets higher-class roads) to orient
 * traffic flow. Accumulates trips bottom-up from leaves toward roots — dead-end
 * streets get only their local buildings, collector roads accumulate sub-branches.
 *
 * Only modifies: road_class in [5..9] (local roads) AND source_id == 0.
 * Excludes motorway_link / trunk_link / primary_link (10/11/12) — those carry
 * highway flow that residential accumulation drastically undercounts.
 * Sets source_id = service-tree-heuristic registry id (heuristic estimate).
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-service-tree.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-service-tree.ts --prefix 841e309
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { SOURCES_BY_KEY } from './lib/sources.js'
import { shouldOverwrite } from './lib/provenance.js'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint8, Uint16 } from 'apache-arrow'

const MY_SOURCE_ID = SOURCES_BY_KEY.get('service-tree-heuristic')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const PREFIX = process.argv.includes('--prefix') ? process.argv[process.argv.indexOf('--prefix') + 1] : ''

const GRID_CELL = 0.0005       // building grid cell size in degrees (~55m at equator)

/**
 * Pack a (lat_idx, lon_idx) cell into one Smi-fitting number for
 * `Map<number, number[]>` lookup. The hot loop in `assignBuildingsGlobally`
 * visits hundreds of millions of cells per dense hex; a numeric key avoids
 * the string allocation a template literal would incur, and a *Smi-shaped*
 * numeric key avoids V8 promoting the Map to HeapNumber comparisons.
 *
 * Each component (latLocal, lonLocal) gets `GRID_KEY_BITS` of room. With
 * 14 bits per axis we can address ~16 k cells per dimension — at GRID_CELL
 * = 0.0005° that's ~880 km, far more than any single H3 r4 hex (~24 km).
 *
 * Indices are stored RELATIVE to a per-hex origin computed in
 * `buildBuildingGrid`, so they're always positive and stay well below
 * the bit limit. `(latLocal << GRID_KEY_BITS) | lonLocal` produces a
 * 28-bit unsigned value — comfortably inside V8's 31-bit Smi range.
 */
const GRID_KEY_BITS = 14
const GRID_KEY_MASK = (1 << GRID_KEY_BITS) - 1

/**
 * Building search radius in meters — only buildings within this distance of an
 * eligible road segment are attributed to it.
 *
 * Arbitrary; tuned by eye to approximate "one block frontage" (typical suburban
 * plot depth + setback). No standard backs this specific number — it is a
 * trade-off between capturing legitimate frontage and avoiding over-assignment
 * in dense grids.
 */
const MAX_BUFFER_M = 50

/**
 * Vehicle trips per dwelling per day (global baseline) and effective occupancy.
 *
 * A.4 recalibration — was `6` (US NHTS 2017 ~5.9 = 1.9 cars × 3.1 trips/car,
 * over-estimates the rest of the world by 20-50 %). New split:
 *   BASE × OCCUPANCY = 4.0 × 0.92 ≈ 3.68 effective trips/dwelling
 *
 * Sources:
 *   - UK NTS 2023 table NTS0205: ~3.8 per household
 *   - MiD 2017 (DE): 3.9
 *   - ORNL NHTS 2022: 5.9 (NA outlier; per-country lookup deferred to Commit 4b)
 *   - OECD HM1-1: ~8 % unoccupied → 0.92 occupancy for Western Europe
 *   - Latin America midpoint ~2.2 (Bogotá/Santiago/Lima EOD surveys),
 *     South Asia ~0.5 (Delhi IITM survey) — these are still high with 3.68
 *     and will be pulled down via per-country lookup in 4b.
 *
 * The legacy TRIPS_PER_DWELLING symbol is retained as the product of the two
 * so callers that multiply by it read "trips per dwelling" correctly without
 * having to track the base/occupancy split.
 */
const TRIPS_PER_DWELLING_BASE = 4.0
const OCCUPANCY = 0.92
const TRIPS_PER_DWELLING = TRIPS_PER_DWELLING_BASE * OCCUPANCY // 3.68

/**
 * Floor for service-tree accumulated AADT — segments below this value are
 * clamped up to avoid degenerate 0-traffic rows.
 *
 * Arbitrary; chosen so the quietest dead-end cul-de-sac still emits at
 * a plausible "a few cars a day" level instead of zero.
 */
const MIN_AADT = 20

/**
 * A.3: per-class upper bound on service-tree accumulated trips. Not a
 * hierarchy-correct cap (1200 residential > 800 tertiary default is
 * intentional — dense urban residentials in Prague Karlín / Madrid Centro
 * reach 1500-2000 genuinely). This is a "pragmatic maximum" — anything
 * above it almost certainly means flow routing put too much through the
 * wrong segment. Missing classes (7 service, 8 track excluded entirely,
 * 10-12 links excluded) have no cap and won't be stamped.
 *
 * Ratios to `default_road_traffic` in engine: 5 residential 2.4×,
 * 6 living_street 2.5×, 9 unclassified 1.5×.
 */
const SERVICE_TREE_CAP_PER_CLASS: Record<number, number> = {
  5: 1200,
  6: 250,
  9: 2000,
}

// Vehicle split matching engine defaults for residential (480/5/10/5 ≈ 96/1/2/1)
// Inherited from normalize.rs::default_road_traffic(5); arbitrary fit to
// CNOSSOS-EU typical values, not from a measurement source.
const SPLIT_MEDIUM = 0.01
const SPLIT_HEAVY = 0.02
const SPLIT_MOTO = 0.01

// ---------- Geometry ----------

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

// ---------- Helpers ----------

function nodeKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)}_${lon.toFixed(5)}`
}

function packGridKey(latLocal: number, lonLocal: number): number {
  return (latLocal << GRID_KEY_BITS) | (lonLocal & GRID_KEY_MASK)
}

/**
 * Estimate dwelling-equivalent count for a building. Feeds trip generation —
 * trips = dwellings × TRIPS_PER_DWELLING (3.68 effective).
 *
 * Critical invariant (A.4): the divisor in every arm is matched to the
 * GFA scale (footprint × floors). The arrow's `area_m2` column stores
 * footprint only (docs/about/index.md:277 defines GFA = footprint ×
 * floors), so a 5-storey 200 m² hotel must be treated as 1000 m² GFA,
 * not 200 m². Previous code used footprint as GFA and under-counted
 * multi-storey buildings 3-10×.
 *
 * Per-type divisors derive from ITE Trip Generation Manual 11th Ed.
 * trip rates (trips per 1000 ft² or per unit) converted to "dwellings"
 * at 3.68 trips/dwelling:
 *
 *   | type | ITE code | basis | divisor |
 *   |---|---|---|---|
 *   | 1 commercial | 820 shopping | ~37 trips/1000 ft² → 1 trip/2.7 m² | 92  (GFA/1 dw) |
 *   | 2 industrial | 110 light ind | ~5 trips/1000 ft² → 1 trip/20 m² | 686 |
 *   | 3 school | 520 elementary, staff-only | ~8 trips/1000 ft² staff-only (pupils walk/bus) | 800 |
 *   | 4 hospital | 610 | 10 trips/bed, bed ≈ 30 m² | 11 |
 *   | 5 church | 560 | 9 trips/1000 ft² peak only — fixed minimal | — |
 *   | 6 hotel | 310 | 8.17 trips/room × 0.5 field × 0.6 off-season → 2.45/room; room ≈ 25 m² | 38 |
 *   | 7 garage | single-unit | — | fixed 1 |
 *   | 8 farm | low mobility | | 200 |
 *   | 9 civic | moderate | | 300 |
 *   | 0 unknown | residential default | 1 dwelling / 80 m² GFA | 80 |
 *
 * Sources: ITE Trip Generation Manual 11th Ed. land-use pages (820 /
 * 110 / 520 / 610 / 560 / 310), VTPI TDM encyclopedia adjustment for
 * field-vs-manual scaling on hotel + retail. Annotated in
 * engine/noise-compute/SPEC.md (A.7).
 */
function estimateDwellings(buildingType: number, floors: number, areaMr2: number | null): number {
  const footprint = areaMr2 ?? 100
  const effectiveFloors = floors > 0 ? floors : 1
  const gfa = footprint * effectiveFloors
  switch (buildingType) {
    case 1:  return Math.min(Math.ceil(gfa / 92),  400) // commercial — ITE 820
    case 2:  return Math.min(Math.ceil(gfa / 686), 200) // industrial — ITE 110
    case 3:  return Math.min(Math.ceil(gfa / 800), 100) // school — ITE 520 staff-only
    case 4:  return Math.min(Math.ceil(gfa / 11),  300) // hospital — ITE 610, 10/bed × 30 m²/bed
    case 5:  return 2                                    // church — ITE 560 peak only, daily minimal
    case 6:  return Math.min(Math.ceil(gfa / 38),  400) // hotel — ITE 310 × 0.5 field × 0.6 off-season
    case 7:  return 1                                    // garage — single car unit
    case 8:  return Math.min(Math.ceil(gfa / 200), 50)  // farm — rural, low mobility
    case 9:  return Math.min(Math.ceil(gfa / 300), 100) // civic / public
    default: return Math.min(Math.max(1, Math.floor(gfa / 80)), 200) // unknown → residential 80 m²/dw
  }
}

function splitAADT(totalTrips: number): { light: number; medium: number; heavy: number; moto: number } {
  const total = Math.max(totalTrips, MIN_AADT)
  const medium = Math.round(total * SPLIT_MEDIUM)
  const heavy = Math.round(total * SPLIT_HEAVY)
  const moto = Math.round(total * SPLIT_MOTO)
  const light = total - medium - heavy - moto
  return { light, medium, heavy, moto }
}

// ---------- Min-heap for Dijkstra ----------

class MinHeap {
  private data: { dist: number; node: string }[] = []

  push(dist: number, node: string) {
    this.data.push({ dist, node })
    let i = this.data.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.data[p].dist <= this.data[i].dist) break
      ;[this.data[p], this.data[i]] = [this.data[i], this.data[p]]
      i = p
    }
  }

  pop(): { dist: number; node: string } {
    const top = this.data[0]
    const last = this.data.pop()!
    if (this.data.length > 0) {
      this.data[0] = last
      let i = 0
      while (true) {
        let smallest = i
        const l = 2 * i + 1, r = 2 * i + 2
        if (l < this.data.length && this.data[l].dist < this.data[smallest].dist) smallest = l
        if (r < this.data.length && this.data[r].dist < this.data[smallest].dist) smallest = r
        if (smallest === i) break
        ;[this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]]
        i = smallest
      }
    }
    return top
  }

  get size() { return this.data.length }
}

// ---------- Graph ----------

interface GraphNode {
  degree: number
  eligibleEdges: number[]
}

function buildGraph(table: any) {
  const n = table.numRows
  const startLat = table.getChild('start_lat')!
  const startLon = table.getChild('start_lon')!
  const endLat = table.getChild('end_lat')!
  const endLon = table.getChild('end_lon')!
  const roadClass = table.getChild('road_class')!
  const existingSourceId = table.getChild('source_id')

  const nodes = new Map<string, GraphNode>()
  const segToNodes: [string, string][] = new Array(n)
  const eligible = new Uint8Array(n)

  function getOrCreate(key: string): GraphNode {
    let nd = nodes.get(key)
    if (!nd) { nd = { degree: 0, eligibleEdges: [] }; nodes.set(key, nd) }
    return nd
  }

  for (let i = 0; i < n; i++) {
    const sKey = nodeKey(startLat.get(i) as number, startLon.get(i) as number)
    const eKey = nodeKey(endLat.get(i) as number, endLon.get(i) as number)
    segToNodes[i] = [sKey, eKey]

    const sNode = getOrCreate(sKey)
    const eNode = getOrCreate(eKey)
    sNode.degree++
    eNode.degree++

    const cls = (roadClass.get(i) as number) ?? 5
    const existingId = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    // Eligibility — local roads only (class 5..9), plus the cls !== 8 guard
    // added in A.3: gravel tracks next to a few cottages used to pick up
    // ~24/day from dwelling flow accumulation (real value ~1/day). Leaving
    // tracks at source_id = 0 drops them to the class-default 5/day in the
    // engine cascade; the A.5 implicit-agricultural factor × 0.1 brings that
    // down to ~0.5/day effective.
    //
    // Service roads (cls 7) stay eligible because residential driveways tag as
    // `highway=service` and do legitimately carry apartment-block flow.
    //
    // Link classes 10-12 excluded: residential flow accumulation drastically
    // undercounts highway-derived ramp traffic, so those stay at source_id=0
    // and fall through to the 15 %-of-mainline class default.
    if (cls >= 5 && cls !== 8 && cls <= 9 && shouldOverwrite(existingId, MY_SOURCE_ID)) {
      eligible[i] = 1
      sNode.eligibleEdges.push(i)
      eNode.eligibleEdges.push(i)
    }
  }

  return { nodes, segToNodes, eligible }
}

// ---------- Connected components ----------

interface Component {
  segments: number[]
  rootNodes: Set<string>
}

function findComponents(
  nodes: Map<string, GraphNode>,
  segToNodes: [string, string][],
  eligible: Uint8Array
): Component[] {
  // Visited as Uint8Array (one byte per segment) — `Set<number>.has/add` runs
  // ~5–10× slower for the millions of probes a dense urban hex incurs.
  const visited = new Uint8Array(eligible.length)
  const components: Component[] = []

  // Queue is a plain array indexed by `head` so we never call `Array.shift()`
  // — V8's shift is O(n) per call, which made `findComponents` O(N²) on
  // giant components and was the dominant cost on dense urban hexes.
  const queue: number[] = []

  for (let i = 0; i < eligible.length; i++) {
    if (!eligible[i] || visited[i]) continue

    const comp: Component = { segments: [], rootNodes: new Set() }
    queue.length = 0
    queue.push(i)
    visited[i] = 1

    let head = 0
    while (head < queue.length) {
      const seg = queue[head++]
      comp.segments.push(seg)

      const [sKey, eKey] = segToNodes[seg]
      for (const nk of [sKey, eKey]) {
        const node = nodes.get(nk)!
        if (node.degree > node.eligibleEdges.length) {
          comp.rootNodes.add(nk)
        }
        const edges = node.eligibleEdges
        for (let k = 0; k < edges.length; k++) {
          const adj = edges[k]
          if (!visited[adj]) {
            visited[adj] = 1
            queue.push(adj)
          }
        }
      }
    }

    components.push(comp)
  }

  return components
}

// ---------- Building spatial grid ----------

interface BuildingGrid {
  grid: Map<number, number[]>
  lats: Float64Array
  lons: Float64Array
  types: Uint8Array
  floors: Uint8Array
  areas: (number | null)[]
  // Per-hex local-coord origin (cell indices). Subtract before packing into
  // the grid key so values stay small and the resulting key fits V8 Smi.
  latOriginIdx: number
  lonOriginIdx: number
}

function buildBuildingGrid(table: any): BuildingGrid {
  const n = table.numRows
  const latCol = table.getChild('centroid_lat')!
  const lonCol = table.getChild('centroid_lon')!
  const typeCol = table.getChild('building_type')!
  const floorCol = table.getChild('floors')!
  const areaCol = table.getChild('area_m2')

  const lats = new Float64Array(n)
  const lons = new Float64Array(n)
  const types = new Uint8Array(n)
  const flrs = new Uint8Array(n)
  const areas: (number | null)[] = new Array(n)

  // First pass: load coords + payload, track min cell idx for the per-hex
  // origin used by the Smi-fitting grid key.
  let minLatIdx = Infinity
  let minLonIdx = Infinity
  for (let i = 0; i < n; i++) {
    const lat = latCol.get(i) as number
    const lon = lonCol.get(i) as number
    lats[i] = lat
    lons[i] = lon
    types[i] = (typeCol.get(i) as number) ?? 0
    flrs[i] = (floorCol.get(i) as number) ?? 0
    const a = areaCol?.get(i)
    areas[i] = a != null ? a as number : null
    const li = Math.floor(lat / GRID_CELL)
    const oi = Math.floor(lon / GRID_CELL)
    if (li < minLatIdx) minLatIdx = li
    if (oi < minLonIdx) minLonIdx = oi
  }
  // Pull origin one cell below the min so the segment-bbox lookup buffer
  // (latCells / lonCells) never produces a negative local coord.
  const latOriginIdx = (Number.isFinite(minLatIdx) ? minLatIdx : 0) - 1
  const lonOriginIdx = (Number.isFinite(minLonIdx) ? minLonIdx : 0) - 1

  // Second pass: bucket into the grid using local indices.
  const grid = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const latLocal = Math.floor(lats[i] / GRID_CELL) - latOriginIdx
    const lonLocal = Math.floor(lons[i] / GRID_CELL) - lonOriginIdx
    const key = packGridKey(latLocal, lonLocal)
    let list = grid.get(key)
    if (!list) { list = []; grid.set(key, list) }
    list.push(i)
  }

  return { grid, lats, lons, types, floors: flrs, areas, latOriginIdx, lonOriginIdx }
}

// ---------- Flow accumulation per component ----------

/**
 * Assign every building to its single nearest eligible segment across the
 * whole hex (A.3: global bestSeg). Previously this ran per-component, so a
 * building within 50 m of segments in two disconnected components was
 * counted in each — inflating flow on both sides of a primary-road split.
 * One pass over all eligible segments + bucketed building grid.
 *
 * Returns `segIdx → totalDwellings` map (sum of `estimateDwellings` for
 * every building whose closest eligible segment is `segIdx`). Buildings
 * outside MAX_BUFFER_M from every eligible segment are simply omitted from
 * the totals. Per-component consumers (`flowAccumulate`) then look up
 * dwellings by segment in O(1) instead of re-iterating every building.
 */
function assignBuildingsGlobally(
  eligibleSegments: number[],
  startLat: any, startLon: any, endLat: any, endLon: any,
  bg: BuildingGrid,
): Map<number, number> {
  // Hot path runs hundreds of millions of building × segment distance checks
  // for dense urban hexes; TypedArray access avoids the per-iteration hash
  // and allocation overhead Map.get/set incur on a numeric key.
  const n = bg.lats.length
  const bestSegArr = new Int32Array(n).fill(-1)
  const bestDistArr = new Float64Array(n)
  bestDistArr.fill(Infinity)

  let sumLat = 0, segCount = 0
  for (const seg of eligibleSegments) { sumLat += startLat.get(seg) as number; segCount++ }
  if (segCount === 0) return new Map()
  const avgLat = sumLat / segCount
  const lonCells = Math.ceil(MAX_BUFFER_M / (111320 * GRID_CELL * Math.cos(avgLat * Math.PI / 180)))
  const latCells = Math.ceil(MAX_BUFFER_M / (110540 * GRID_CELL))

  const lats = bg.lats
  const lons = bg.lons
  const gridMap = bg.grid
  const latOff = bg.latOriginIdx
  const lonOff = bg.lonOriginIdx

  for (const seg of eligibleSegments) {
    const sLat = startLat.get(seg) as number
    const sLon = startLon.get(seg) as number
    const eLat = endLat.get(seg) as number
    const eLon = endLon.get(seg) as number

    const gMinLat = Math.floor(Math.min(sLat, eLat) / GRID_CELL) - latCells
    const gMaxLat = Math.floor(Math.max(sLat, eLat) / GRID_CELL) + latCells
    const gMinLon = Math.floor(Math.min(sLon, eLon) / GRID_CELL) - lonCells
    const gMaxLon = Math.floor(Math.max(sLon, eLon) / GRID_CELL) + lonCells

    for (let gLat = gMinLat; gLat <= gMaxLat; gLat++) {
      const latPart = (gLat - latOff) << GRID_KEY_BITS
      for (let gLon = gMinLon; gLon <= gMaxLon; gLon++) {
        const buildings = gridMap.get(latPart | ((gLon - lonOff) & GRID_KEY_MASK))
        if (!buildings) continue
        for (let k = 0; k < buildings.length; k++) {
          const bi = buildings[k]
          const dist = pointToSegmentDist(lats[bi], lons[bi], sLat, sLon, eLat, eLon)
          if (dist <= MAX_BUFFER_M && dist < bestDistArr[bi]) {
            bestDistArr[bi] = dist
            bestSegArr[bi] = seg
          }
        }
      }
    }
  }

  // Aggregate to `seg → totalDwellings` in one O(n) walk so each component
  // consumer can read its segments by O(1) lookup instead of iterating
  // every building. estimateDwellings is invoked once per assigned building
  // (was once per component-membership previously, same total).
  const segDwellings = new Map<number, number>()
  for (let bi = 0; bi < n; bi++) {
    const seg = bestSegArr[bi]
    if (seg < 0) continue
    const dw = estimateDwellings(bg.types[bi], bg.floors[bi], bg.areas[bi])
    segDwellings.set(seg, (segDwellings.get(seg) ?? 0) + dw)
  }
  return segDwellings
}

function flowAccumulate(
  comp: Component,
  segToNodes: [string, string][],
  lengthCol: any,
  segDwellingsGlobal: Map<number, number>,
): Map<number, number> {
  // Build component-local adjacency
  const localAdj = new Map<string, number[]>()
  const compNodes = new Set<string>()
  for (const seg of comp.segments) {
    const [sKey, eKey] = segToNodes[seg]
    for (const nk of [sKey, eKey]) {
      compNodes.add(nk)
      let list = localAdj.get(nk)
      if (!list) { list = []; localAdj.set(nk, list) }
      list.push(seg)
    }
  }

  // --- Step 1: pull per-component local trips out of the global
  // segment→dwelling map. Each segment is only ever in one component's
  // segments list, so this is a direct lookup. Multiplying integer
  // dwellings by TRIPS_PER_DWELLING once per segment keeps segFlow
  // independent of building-iteration order (integer addition associative,
  // floats aren't).
  const segFlow = new Map<number, number>()
  for (const seg of comp.segments) {
    const dw = segDwellingsGlobal.get(seg) ?? 0
    segFlow.set(seg, dw * TRIPS_PER_DWELLING)
  }

  // --- Step 2: Multi-source Dijkstra from root nodes ---
  const dist = new Map<string, number>()
  const downSeg = new Map<string, number>()
  for (const nk of compNodes) dist.set(nk, Infinity)

  const roots = comp.rootNodes
  if (roots.size === 0) {
    // Isolated: pick highest-degree node as pseudo-root
    let best = '', bestDeg = -1
    for (const nk of compNodes) {
      const d = localAdj.get(nk)!.length
      if (d > bestDeg) { bestDeg = d; best = nk }
    }
    roots.add(best)
  }

  const pq = new MinHeap()
  for (const r of roots) { dist.set(r, 0); pq.push(0, r) }

  while (pq.size > 0) {
    const { dist: d, node: u } = pq.pop()
    if (d > dist.get(u)!) continue

    const edges = localAdj.get(u)
    if (!edges) continue
    for (const seg of edges) {
      const [sKey, eKey] = segToNodes[seg]
      const v = (sKey === u) ? eKey : sKey
      const len = Math.max(1, (lengthCol.get(seg) as number) ?? 1)
      const newDist = dist.get(u)! + len
      if (newDist < dist.get(v)!) {
        dist.set(v, newDist)
        downSeg.set(v, seg)
        pq.push(newDist, v)
      }
    }
  }

  // --- Step 3: Bottom-up accumulation ---
  const sortedNodes = Array.from(compNodes).sort((a, b) => dist.get(b)! - dist.get(a)!)

  for (const u of sortedNodes) {
    // Sum flow arriving at u from upstream segments (where u is the "lower" end)
    let inflow = 0
    const edges = localAdj.get(u)
    if (!edges) continue
    for (const seg of edges) {
      const [sKey, eKey] = segToNodes[seg]
      const other = (sKey === u) ? eKey : sKey
      // This segment flows toward u if u is closer to root (lower dist)
      if (dist.get(other)! > dist.get(u)!) {
        inflow += segFlow.get(seg)!
      }
    }

    // Push inflow into the downstream segment
    const dSeg = downSeg.get(u)
    if (dSeg !== undefined) {
      segFlow.set(dSeg, segFlow.get(dSeg)! + inflow)
    }
  }

  return segFlow
}

// ---------- Process one hex ----------

function processHex(hexId: string): { enriched: number; totalResidential: number } | null {
  const roadsPath = resolve(H3R4_DIR, hexId, 'roads.arrow')
  const buildingsPath = resolve(H3R4_DIR, hexId, 'buildings.arrow')
  if (!existsSync(roadsPath) || !existsSync(buildingsPath)) return null

  const roadTable = tableFromIPC(readFileSync(roadsPath))
  const n = roadTable.numRows
  if (n === 0) return null

  const buildingTable = tableFromIPC(readFileSync(buildingsPath))
  if (buildingTable.numRows === 0) return null

  const { nodes, segToNodes, eligible } = buildGraph(roadTable)

  let eligibleCount = 0
  for (let i = 0; i < n; i++) if (eligible[i]) eligibleCount++
  if (eligibleCount === 0) return null

  const components = findComponents(nodes, segToNodes, eligible)
  if (components.length === 0) return null

  const bg = buildBuildingGrid(buildingTable)
  const startLat = roadTable.getChild('start_lat')!
  const startLon = roadTable.getChild('start_lon')!
  const endLat = roadTable.getChild('end_lat')!
  const endLon = roadTable.getChild('end_lon')!
  const lengthCol = roadTable.getChild('length_m')!

  // A.3: global building→segment assignment. One pass over every eligible
  // segment across all components — each building now lands on exactly one
  // segment, no more double-counting across primary-road-split components.
  // (Spread `push(...comp.segments)` overflows the V8 call stack when a
  // single urban component holds >100 k segments — use explicit loops.)
  let eligibleCapacity = 0
  for (const comp of components) eligibleCapacity += comp.segments.length
  const eligibleSegments: number[] = new Array(eligibleCapacity)
  let writeIdx = 0
  for (const comp of components) {
    const segs = comp.segments
    for (let i = 0; i < segs.length; i++) eligibleSegments[writeIdx++] = segs[i]
  }
  const globalBestSeg = assignBuildingsGlobally(
    eligibleSegments, startLat, startLon, endLat, endLon, bg,
  )

  // Flow accumulation per component (each sees only buildings whose best
  // segment belongs to it — Set-based gate inside flowAccumulate).
  const segAADT = new Map<number, { light: number; medium: number; heavy: number; moto: number }>()
  for (const comp of components) {
    const segFlow = flowAccumulate(comp, segToNodes, lengthCol, globalBestSeg)
    const roadClassCol = roadTable.getChild('road_class')
    for (const [seg, trips] of segFlow) {
      const cls = (roadClassCol?.get(seg) as number) ?? 5
      const capped = Math.min(trips, SERVICE_TREE_CAP_PER_CLASS[cls] ?? Infinity)
      segAADT.set(seg, splitAADT(capped))
    }
  }

  if (segAADT.size === 0) return null

  // Write back — EC pattern: copy existing values first
  const existingLight = roadTable.getChild('aadt_light')
  const existingMed = roadTable.getChild('aadt_medium')
  const existingHvy = roadTable.getChild('aadt_heavy')
  const existingMoto = roadTable.getChild('aadt_moto')
  const existingSourceId = roadTable.getChild('source_id')
  const aadtLight = new Int32Array(n)
  const aadtMedium = new Int32Array(n)
  const aadtHeavy = new Int32Array(n)
  const aadtMoto = new Int32Array(n)
  const sourceId = new Uint16Array(n)

  for (let i = 0; i < n; i++) {
    aadtLight[i] = (existingLight?.get(i) as number) ?? 0
    aadtMedium[i] = (existingMed?.get(i) as number) ?? 0
    aadtHeavy[i] = (existingHvy?.get(i) as number) ?? 0
    aadtMoto[i] = (existingMoto?.get(i) as number) ?? 0
    sourceId[i] = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
  }

  let enriched = 0
  for (const [seg, aadt] of segAADT) {
    // Eligibility was already gated via shouldOverwrite() in buildGraph().
    // Whole-row atomic write — payload + dataset_id together.
    if (!shouldOverwrite(sourceId[seg], MY_SOURCE_ID)) continue
    aadtLight[seg] = aadt.light
    aadtMedium[seg] = aadt.medium
    aadtHeavy[seg] = aadt.heavy
    aadtMoto[seg] = aadt.moto
    sourceId[seg] = MY_SOURCE_ID
    enriched++
  }

  const columns: Record<string, any> = {}
  for (const field of roadTable.schema.fields) {
    if (['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'source_id'].includes(field.name)) continue
    columns[field.name] = roadTable.getChild(field.name)!
  }
  columns['aadt_light'] = vectorFromArray(aadtLight, new Int32())
  columns['aadt_medium'] = vectorFromArray(aadtMedium, new Int32())
  columns['aadt_heavy'] = vectorFromArray(aadtHeavy, new Int32())
  columns['aadt_moto'] = vectorFromArray(aadtMoto, new Int32())
  columns['source_id'] = vectorFromArray(sourceId, new Uint16())
  const newTable = makeTable(columns)
  writeFileSync(roadsPath, Buffer.from(tableToIPC(newTable, 'file')))

  return { enriched, totalResidential: eligibleCount }
}

// ---------- Main ----------

function main() {
  if (!existsSync(H3R4_DIR)) {
    console.error(`ERROR: H3R4 directory not found: ${H3R4_DIR}`)
    process.exit(1)
  }

  // Sort explicit so START_INDEX is reproducible across runs (readdirSync
  // alphabetical order isn't filesystem-guaranteed).
  const hexDirs = readdirSync(H3R4_DIR).filter(d => {
    if (d.startsWith('.')) return false
    if (PREFIX && !d.startsWith(PREFIX)) return false
    return true
  }).sort()
  const rawStart = parseInt(process.env.START_INDEX || '0', 10)
  const START_INDEX = Number.isFinite(rawStart)
    ? Math.min(Math.max(0, rawStart), hexDirs.length)
    : 0

  console.log(`Service-tree AADT enrichment (v2: flow accumulation)`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Hexes: ${hexDirs.length}${PREFIX ? ` (prefix: ${PREFIX})` : ''}${START_INDEX > 0 ? ` (resume from #${START_INDEX})` : ''}`)

  const startTime = Date.now()
  let lastProgress = startTime
  let hexesProcessed = START_INDEX
  let hexesEnriched = 0
  let totalSegmentsEnriched = 0
  let totalResidential = 0

  for (let hi = START_INDEX; hi < hexDirs.length; hi++) {
    const hexId = hexDirs[hi]
    const result = processHex(hexId)

    if (result) {
      hexesEnriched++
      totalSegmentsEnriched += result.enriched
      totalResidential += result.totalResidential
    }
    hexesProcessed++

    const now = Date.now()
    if (now - lastProgress >= 10_000) {
      lastProgress = now
      const elapsed = ((now - startTime) / 1000).toFixed(0)
      process.stdout.write(`\r  [${elapsed}s] ${hexesProcessed}/${hexDirs.length} hexes, ${hexesEnriched} enriched, ${totalSegmentsEnriched} segments`)
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n\n=== Results (${elapsed}s) ===`)
  console.log(`  Hexes: ${hexesProcessed} processed, ${hexesEnriched} enriched`)
  console.log(`  Segments: ${totalSegmentsEnriched} enriched / ${totalResidential} eligible residential`)
  if (totalResidential > 0) {
    console.log(`  Coverage: ${(totalSegmentsEnriched / totalResidential * 100).toFixed(1)}%`)
  }
}

main()
