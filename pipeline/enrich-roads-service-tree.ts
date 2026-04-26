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
import { SOURCE_ID_SERVICE_TREE_HEURISTIC } from './lib/source-ids.generated.js'

const MY_SOURCE_ID = SOURCE_ID_SERVICE_TREE_HEURISTIC

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
export const MAX_BUFFER_M = 50

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
export const TRIPS_PER_DWELLING = TRIPS_PER_DWELLING_BASE * OCCUPANCY // 3.68

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
 * wrong segment. Class 8 (track) is excluded from eligibility entirely; no
 * cap entry needed.
 *
 * Ratios to `default_road_traffic` in engine: 5 residential 2.4×,
 * 6 living_street 2.5×, 7 service 1.6×, 9 unclassified 1.5×.
 *
 * Class 7 (service) is the one calibration outlier in the dict: service
 * roads cover everything from a 5-storey apartment driveway (~200 dw × 3.68
 * = 700 trips genuine) to a 30 m parking aisle (~5 trips). The OSM `service=*`
 * sub-tag would let us split these but the road schema doesn't preserve it
 * (engine/osm-extract/src/finalize.rs:124). Without that signal we pick a
 * cap of 400 — 1.6× the engine default of 250, leaves room for one mid-rise
 * apartment block, hard-clamps the Pasito-class 1700+ runaway. Apartment
 * driveways with >100 dw will still hit the cap; that's a known undercount
 * pending OSM `service` sub-tag extraction.
 */
export const SERVICE_TREE_CAP_PER_CLASS: Record<number, number> = {
  5: 1200,
  6: 250,
  7: 400,
  9: 2000,
}

// Vehicle split matching engine defaults for residential (480/5/10/5 ≈ 96/1/2/1)
// Inherited from normalize.rs::default_road_traffic(5); arbitrary fit to
// CNOSSOS-EU typical values, not from a measurement source.
const SPLIT_MEDIUM = 0.01
const SPLIT_HEAVY = 0.02
const SPLIT_MOTO = 0.01

// ---------- Geometry ----------
//
// Service-tree's hot building-assignment loop runs ~3.7 G distance probes
// for a Jakarta-class hex. To avoid paying `Math.cos` + degree→metre
// arithmetic per probe, the inner loop runs in *pre-projected* metres:
// `buildBuildingGrid` materialises `xs/ys` `Float64Array` once using a
// single hex-level cosLat from the average building latitude, and
// `assignBuildingsGlobally` projects segment endpoints the same way.
// Within a 24 km H3 r4 hex cosLat varies <0.05 % — well under the 50 m
// `MAX_BUFFER_M` heuristic — so the assignment is bit-identical.

const M_PER_DEG_LON_EQUATOR = 111320
const M_PER_DEG_LAT = 110540

/**
 * Distance from point `p` to segment `a → b`, all coordinates already
 * projected to local metres by the caller. Pure subtract/multiply/dot;
 * no trig, no degree→metre conversion.
 */
function pointToSegmentDistXY(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) {
    const ex = px - ax, ey = py - ay
    return Math.sqrt(ex * ex + ey * ey)
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  const ex = px - cx, ey = py - cy
  return Math.sqrt(ex * ex + ey * ey)
}

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
export function estimateDwellings(buildingType: number, floors: number, areaMr2: number | null): number {
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

export function splitAADT(totalTrips: number): { light: number; medium: number; heavy: number; moto: number } {
  const total = Math.max(totalTrips, MIN_AADT)
  const medium = Math.round(total * SPLIT_MEDIUM)
  const heavy = Math.round(total * SPLIT_HEAVY)
  const moto = Math.round(total * SPLIT_MOTO)
  const light = total - medium - heavy - moto
  return { light, medium, heavy, moto }
}

// ---------- Min-heap for Dijkstra ----------

class MinHeap {
  private data: { dist: number; node: number }[] = []

  push(dist: number, node: number) {
    this.data.push({ dist, node })
    let i = this.data.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.data[p].dist <= this.data[i].dist) break
      ;[this.data[p], this.data[i]] = [this.data[i], this.data[p]]
      i = p
    }
  }

  pop(): { dist: number; node: number } {
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
//
// Nodes are interned to dense integer ids during `buildGraph`; everything
// downstream addresses them via `Int32Array` instead of string keys. For a
// 100 k-segment Praha hex that is ~7-10 MB of template-literal strings and
// ~1.5 M Map-of-string operations the engine no longer pays per pass.

export interface GraphNode {
  eligibleEdges: number[]
  // True iff the node touches a real motor-vehicle exit. Tracks (cls 8) are
  // NOT exits — counting them was the Pasito Blanco bug where service road
  // OSM 69951934 inflated from ~30 trips/day to 1700+ via fake-root flow.
  // See buildGraph() for the three sources that flip this flag.
  hasExitEdge: boolean
}

export interface Graph {
  nodes: GraphNode[]                    // indexed by node id
  segNodeIds: Int32Array                // length 2*n: [start_id, end_id, …]
  eligible: Uint8Array                  // 1 byte per segment
}

export function buildGraph(table: any): Graph {
  const n = table.numRows
  const startLat = table.getChild('start_lat')!
  const startLon = table.getChild('start_lon')!
  const endLat = table.getChild('end_lat')!
  const endLon = table.getChild('end_lon')!
  const roadClass = table.getChild('road_class')!
  const existingSourceId = table.getChild('source_id')

  // Intern (lat, lon) pairs into dense ids 0..numNodes-1. The string key
  // is only used during construction; the rest of the pipeline never sees
  // it again.
  const nodeIdByKey = new Map<string, number>()
  const nodes: GraphNode[] = []

  function internNode(key: string): number {
    let id = nodeIdByKey.get(key)
    if (id === undefined) {
      id = nodes.length
      nodes.push({ eligibleEdges: [], hasExitEdge: false })
      nodeIdByKey.set(key, id)
    }
    return id
  }

  const segNodeIds = new Int32Array(n * 2)
  const eligible = new Uint8Array(n)

  for (let i = 0; i < n; i++) {
    const sKey = nodeKey(startLat.get(i) as number, startLon.get(i) as number)
    const eKey = nodeKey(endLat.get(i) as number, endLon.get(i) as number)
    const sId = internNode(sKey)
    const eId = internNode(eKey)
    segNodeIds[i * 2] = sId
    segNodeIds[i * 2 + 1] = eId

    const cls = (roadClass.get(i) as number) ?? 5
    const existingId = existingSourceId ? (existingSourceId.get(i) as number) ?? 0 : 0
    // Eligibility (in routing graph): local motor cls 5–9 *except* track. A.3:
    // tracks would pick up ~24/day from flow accumulation against a real ~1/day.
    // Links 10–12 excluded too — residential accumulation undercounts highway-
    // derived ramp traffic, so they stay at source_id=0 → engine class default.
    const isLocalMotor = cls >= 5 && cls <= 9 && cls !== 8
    if (isLocalMotor && shouldOverwrite(existingId, MY_SOURCE_ID)) {
      eligible[i] = 1
      nodes[sId].eligibleEdges.push(i)
      nodes[eId].eligibleEdges.push(i)
    } else if (cls < 5 || (cls >= 10 && cls <= 12) || isLocalMotor) {
      // Real motor exit. Three sources fold here:
      //   - higher-class road (cls 0–4) or link (cls 10–12)
      //   - local motor non-overwriteable by us (already filled by measured
      //     source) — must still root the adjacent service-tree component, else
      //     pseudo-root pulls flow inward instead of out toward the measured neighbour.
      nodes[sId].hasExitEdge = true
      nodes[eId].hasExitEdge = true
    }
  }

  return { nodes, segNodeIds, eligible }
}

// ---------- Connected components ----------

export interface Component {
  segments: number[]
  rootNodes: Set<number>     // global node ids; small per component
}

export function findComponents(graph: Graph): Component[] {
  const { nodes, segNodeIds, eligible } = graph
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

      const sId = segNodeIds[seg * 2]
      const eId = segNodeIds[seg * 2 + 1]
      for (let endSel = 0; endSel < 2; endSel++) {
        const nodeId = endSel === 0 ? sId : eId
        const node = nodes[nodeId]
        if (node.hasExitEdge) {
          comp.rootNodes.add(nodeId)
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

export interface BuildingGrid {
  grid: Map<number, number[]>
  lats: Float64Array
  lons: Float64Array
  /** Pre-projected building coords in metres (using the per-hex `mPerDegLon`).
   *  Inner loop reads these instead of `lats/lons` so it never has to call
   *  `Math.cos` or multiply by `111320 * cosLat` per probe. */
  xs: Float64Array
  ys: Float64Array
  /** Hex-level metres-per-degree-longitude — `Math.cos(avgLat) * 111_320`.
   *  Caller projects segment endpoints with the same factor so building
   *  and segment coords share the same local frame. */
  mPerDegLon: number
  types: Uint8Array
  floors: Uint8Array
  areas: (number | null)[]
  // Per-hex local-coord origin (cell indices). Subtract before packing into
  // the grid key so values stay small and the resulting key fits V8 Smi.
  latOriginIdx: number
  lonOriginIdx: number
}

export function buildBuildingGrid(table: any): BuildingGrid {
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
  // origin used by the Smi-fitting grid key, and accumulate the latitude
  // sum so we can derive a single `cosLat` for the whole hex.
  let minLatIdx = Infinity
  let minLonIdx = Infinity
  let latSum = 0
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
    latSum += lat
  }
  // Pull origin one cell below the min so the segment-bbox lookup buffer
  // (latCells / lonCells) never produces a negative local coord.
  const latOriginIdx = (Number.isFinite(minLatIdx) ? minLatIdx : 0) - 1
  const lonOriginIdx = (Number.isFinite(minLonIdx) ? minLonIdx : 0) - 1

  // One cosLat for the whole hex. Across a 24 km r4 hex (≈0.22° lat span)
  // cos varies <0.05 % — well under the 50 m MAX_BUFFER_M threshold.
  const avgLat = n > 0 ? latSum / n : 0
  const mPerDegLon = M_PER_DEG_LON_EQUATOR * Math.cos(avgLat * Math.PI / 180)

  // Second pass: pre-project every building into local metres + bucket
  // into the grid using local cell indices.
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const grid = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    xs[i] = lons[i] * mPerDegLon
    ys[i] = lats[i] * M_PER_DEG_LAT
    const latLocal = Math.floor(lats[i] / GRID_CELL) - latOriginIdx
    const lonLocal = Math.floor(lons[i] / GRID_CELL) - lonOriginIdx
    const key = packGridKey(latLocal, lonLocal)
    let list = grid.get(key)
    if (!list) { list = []; grid.set(key, list) }
    list.push(i)
  }

  return {
    grid, lats, lons, xs, ys, mPerDegLon,
    types, floors: flrs, areas,
    latOriginIdx, lonOriginIdx,
  }
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
export function assignBuildingsGlobally(
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

  if (eligibleSegments.length === 0) return new Map()

  // Bbox padding for the segment-cell scan: how many ±cells we have to
  // visit to cover MAX_BUFFER_M of slop in each direction. Uses the same
  // hex-level `mPerDegLon` (= 111_320 × cosLat) the building xs were
  // projected with — keeps the bbox check coordinate-consistent with the
  // distance check below.
  const lonCells = Math.ceil(MAX_BUFFER_M / (bg.mPerDegLon * GRID_CELL))
  const latCells = Math.ceil(MAX_BUFFER_M / (M_PER_DEG_LAT * GRID_CELL))

  const xs = bg.xs
  const ys = bg.ys
  const mLon = bg.mPerDegLon
  const gridMap = bg.grid
  const latOff = bg.latOriginIdx
  const lonOff = bg.lonOriginIdx

  for (const seg of eligibleSegments) {
    const sLat = startLat.get(seg) as number
    const sLon = startLon.get(seg) as number
    const eLat = endLat.get(seg) as number
    const eLon = endLon.get(seg) as number

    // Project segment endpoints once per segment. Inner loop now operates
    // entirely in metres — pure subtract/multiply/sqrt, zero trig.
    const sx = sLon * mLon
    const sy = sLat * M_PER_DEG_LAT
    const ex = eLon * mLon
    const ey = eLat * M_PER_DEG_LAT

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
          const dist = pointToSegmentDistXY(xs[bi], ys[bi], sx, sy, ex, ey)
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

export function flowAccumulate(
  comp: Component,
  segNodeIds: Int32Array,
  lengthCol: any,
  segDwellingsGlobal: Map<number, number>,
): Map<number, number> {
  // Component-local node ids: dense 0..K-1, mapped from the global ids
  // that appear in this component's segments. Per-component dense ids let
  // the Dijkstra distance / parent / sorted state live in `Float64Array`
  // / `Int32Array` instead of `Map<string, …>`, which was the hottest
  // remaining service-tree path on dense urban hexes.
  const globalToLocal = new Map<number, number>()
  const localToGlobal: number[] = []
  const localAdj: number[][] = []
  function intern(globalId: number): number {
    let local = globalToLocal.get(globalId)
    if (local === undefined) {
      local = localToGlobal.length
      localToGlobal.push(globalId)
      localAdj.push([])
      globalToLocal.set(globalId, local)
    }
    return local
  }

  // Build component-local adjacency keyed by dense local ids.
  const segLocalEnds: { a: number; b: number }[] = new Array(comp.segments.length)
  for (let i = 0; i < comp.segments.length; i++) {
    const seg = comp.segments[i]
    const a = intern(segNodeIds[seg * 2])
    const b = intern(segNodeIds[seg * 2 + 1])
    segLocalEnds[i] = { a, b }
    localAdj[a].push(seg)
    localAdj[b].push(seg)
  }
  // segIdx -> (localA, localB): keyed by global seg index so Step 2/3 can
  // look up the two endpoints without touching the global Int32Array.
  const segLocalLookup = new Map<number, { a: number; b: number }>()
  for (let i = 0; i < comp.segments.length; i++) {
    segLocalLookup.set(comp.segments[i], segLocalEnds[i])
  }

  const numLocal = localToGlobal.length

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
  const dist = new Float64Array(numLocal)
  dist.fill(Infinity)
  const downSeg = new Int32Array(numLocal)
  downSeg.fill(-1)

  // Translate root nodes to local ids; also handle the "no roots → pick
  // highest-degree node as pseudo-root" fallback in local space.
  const localRoots: number[] = []
  for (const globalId of comp.rootNodes) {
    const local = globalToLocal.get(globalId)
    if (local !== undefined) localRoots.push(local)
  }
  if (localRoots.length === 0) {
    let best = 0, bestDeg = -1
    for (let l = 0; l < numLocal; l++) {
      const d = localAdj[l].length
      if (d > bestDeg) { bestDeg = d; best = l }
    }
    localRoots.push(best)
  }

  const pq = new MinHeap()
  for (const r of localRoots) { dist[r] = 0; pq.push(0, r) }

  while (pq.size > 0) {
    const { dist: d, node: u } = pq.pop()
    if (d > dist[u]) continue

    const edges = localAdj[u]
    for (let k = 0; k < edges.length; k++) {
      const seg = edges[k]
      const ends = segLocalLookup.get(seg)!
      const v = ends.a === u ? ends.b : ends.a
      const len = Math.max(1, (lengthCol.get(seg) as number) ?? 1)
      const newDist = d + len
      if (newDist < dist[v]) {
        dist[v] = newDist
        downSeg[v] = seg
        pq.push(newDist, v)
      }
    }
  }

  // --- Step 3: Bottom-up accumulation ---
  // Indices 0..numLocal-1 sorted by descending dist — leaves first, roots
  // last. Backed by an `Int32Array` so the sort comparator only touches
  // primitive Float64 reads.
  const sortedLocals = new Int32Array(numLocal)
  for (let i = 0; i < numLocal; i++) sortedLocals[i] = i
  // Convert to a regular array for sort (TypedArray sort is numeric-only;
  // we want comparator-based descending-by-dist). Numeric ids → no string
  // hash work in the comparator.
  const sortedArr = Array.from(sortedLocals)
  sortedArr.sort((a, b) => dist[b] - dist[a])

  for (const u of sortedArr) {
    let inflow = 0
    const edges = localAdj[u]
    const distU = dist[u]
    for (let k = 0; k < edges.length; k++) {
      const seg = edges[k]
      const ends = segLocalLookup.get(seg)!
      const other = ends.a === u ? ends.b : ends.a
      if (dist[other] > distU) {
        inflow += segFlow.get(seg)!
      }
    }

    const dSeg = downSeg[u]
    if (dSeg !== -1) {
      segFlow.set(dSeg, segFlow.get(dSeg)! + inflow)
    }
  }

  return segFlow
}

// ---------- Debug hook ----------

function parseDebugOsmId(): number | null {
  const raw = process.env.DEBUG_OSM_ID
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    console.error(`[service-tree] DEBUG_OSM_ID=${raw} not numeric — ignored`)
    return null
  }
  return n
}

function debugFlow(segFlow: Map<number, number>, osmIdCol: any, target: number, segDw: Map<number, number>) {
  for (const [seg, trips] of segFlow) {
    if (Number(osmIdCol.get(seg)) !== target) continue
    const localDw = segDw.get(seg) ?? 0
    const localTrips = localDw * TRIPS_PER_DWELLING
    console.error(`  [DEBUG seg ${seg} osm=${target}] local_dw=${localDw} local_trips=${localTrips.toFixed(1)} TOTAL_FLOW=${trips.toFixed(0)} through_flow=${(trips - localTrips).toFixed(0)}`)
  }
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

  const graph = buildGraph(roadTable)

  let eligibleCount = 0
  for (let i = 0; i < n; i++) if (graph.eligible[i]) eligibleCount++
  if (eligibleCount === 0) return null

  const components = findComponents(graph)
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

  // Flow accumulation per component, reading the precomputed seg→dwellings
  // map by direct lookup (no per-component re-scan of every building).
  const segAADT = new Map<number, { light: number; medium: number; heavy: number; moto: number }>()
  const roadClassCol = roadTable.getChild('road_class')
  const debugTarget = parseDebugOsmId()
  const osmIdCol = debugTarget !== null ? roadTable.getChild('osm_id') : undefined
  for (const comp of components) {
    const segFlow = flowAccumulate(comp, graph.segNodeIds, lengthCol, globalBestSeg)
    if (osmIdCol) debugFlow(segFlow, osmIdCol, debugTarget!, globalBestSeg)
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

// Run main only when this file is invoked as a script — not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
