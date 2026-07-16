/**
 * Rail-segment graph — the ONE topology SSOT for the rail graph-walk matcher,
 * the R15/R16 continuity auditors and enrichment-status metrics (2026-07-15
 * railway enrichment fix, see the `pro-e-sd-zaj-m-wobbly-liskov` plan §Phase 1).
 * Pure, no file I/O — callers own reading Arrow/GTFS and writing stamps.
 *
 * `buildRailGraph` interns segment endpoints via `nodeKey()` (spatial.ts) and
 * then performs T-JUNCTION HEALING: the extractor's collinear-merge
 * (`engine/osm-extract/src/microsegment.rs::split`) swallows junction
 * vertices, so a branch's endpoint can land in the *middle* of another
 * segment's body instead of exactly on it — an endpoint-only graph would
 * leave that branch dangling, unreachable from the segment it physically
 * meets. Healing finds those mid-body touches and splits the touched
 * segment into sub-edges that share the branch's node, all still tagged
 * with the ORIGINAL segment's `key` so a walked stamp maps back to one
 * Arrow row regardless of how many sub-edges it now spans.
 *
 * Routing (`walkRailStationPairs`), the parallel-spread pass and the R15/R16
 * detectors live in the sibling `rail-graph-metrics.ts` (kept out of this
 * file to stay near the ~300-line target) — they import the types and
 * `effectiveRailTraffic`/`buildRailGraph` from here; no logic is duplicated
 * between the two files.
 */

import { nodeKey, flatDist, pointToSegmentDist, pointToSegmentParamT, M_PER_DEG_LAT, M_PER_DEG_LON_EQ } from './spatial.js'

// ── Tunables (cited at each use site) ───────────────────────────────────────

/** A GTFS/CZPTT stop's GPS must resolve to a graph node within this radius or
 *  the pair is dropped (never a chord fallback — see plan Key decisions). */
export const STATION_SNAP_RADIUS_M = 300
/** Hard walk-length bound: `WALK_DETOUR_RATIO * greatCircle + WALK_DETOUR_SLACK_M`.
 *  Rejects a chord-vs-meander mismatch when the graph does not actually run
 *  anywhere near the straight line (the Tochovice-Březnice failure mode). */
export const WALK_DETOUR_RATIO = 2.5
export const WALK_DETOUR_SLACK_M = 2000
/** Ambiguity proxy: an alternate path within 20% of the best path's length... */
export const WALK_AMBIGUITY_LENGTH_RATIO = 1.2
/** ...AND sharing less than half the best path's edges is a genuinely
 *  different route, not a local detour around one busy junction — the pair
 *  fails as 'ambiguous' rather than guessing which corridor carries the count. */
export const WALK_AMBIGUITY_SHARED_EDGE_FRACTION = 0.5
/** Soft corridor constraint: with a GTFS `shapes.txt` polyline, edges farther
 *  than this from the shape are excluded from that pair's search entirely. */
export const SHAPE_CORRIDOR_TOLERANCE_M = 250
/** T-junction healing tolerance — see the module doc. Deliberately tight (the
 *  extractor's own vertex precision), so this never merges two genuinely
 *  distinct nearby tracks. */
export const T_JUNCTION_TOLERANCE_M = 1.0
/** A rail-flow jump at a node within this radius of a real stop is explained
 *  by boardings/alightings, not a matching bug (R15/R16 exemption). */
export const RAIL_STOP_EXEMPT_RADIUS_M = 300
/** R15/R16 fire threshold: effective traffic must jump more than this
 *  multiple across a degree-2 node with no junction/stop to explain it. */
export const RAIL_JUMP_RATIO = 3
/** R15/R16 floor: below this effective trains/day, ratio noise (2 vs 7) is
 *  not worth flagging even past RAIL_JUMP_RATIO. */
export const RAIL_MIN_EFFECTIVE_TRAINS_PER_DAY = 20
/** Parallel-track sibling search radius (segment-midpoint distance, metres). */
export const PARALLEL_SPREAD_RADIUS_M = 50
/** Twin-track ambiguity exemption (2026-07-16 Step-B refinement, verified on
 *  live CZ Step-A data: 113 of 150 failed pairs): before failing a pair as
 *  'ambiguous', the walk tests whether the alt path found by the penalized
 *  re-run is merely the PARALLEL TWIN of the best path (the sibling track of
 *  a double-track line) rather than a genuinely different corridor. If at
 *  least this fraction of alt's own non-shared stampable LENGTH passes the
 *  twin-classification gate (`WALK_TWIN_LATERAL_M` lateral + heading <10°,
 *  mod 180 — NOT the spread's token arms, see that constant's two-radius
 *  reasoning) against the best path's
 *  edges, the pair is NOT ambiguous — the parallel spread unifies the two
 *  tracks anyway. LENGTH-weighted (2026-07-16 /gg fix batch item 5): an
 *  edge-count fraction let 8 short twin stubs outvote 2 long off-corridor
 *  edges (8/10 edges "twin" while ~95 % of the alt's LENGTH ran elsewhere).
 *  Genuine dual corridors (e.g. Praha Vršovice->Holešovice via Libeň vs via
 *  Bubny) sit hundreds of metres apart and stay ambiguous. */
export const WALK_TWIN_ALT_EDGE_FRACTION = 0.8
/** Lateral radius of the ambiguity TWIN-CLASSIFICATION gate — deliberately
 *  its OWN constant, NOT the parallel spread's token arms (2026-07-16 review
 *  round; provenance: CZ Step-A v3 run, ambiguous 29 -> 71 regression when
 *  the twin gate reused the spread's 15 m token-less radius). TWO radii
 *  because the two passes answer different questions: the SPREAD divides
 *  acoustic energy between sibling tracks, so it must be strict (15 m
 *  token-less — real double-track spacing, never two distinct lines); twin
 *  CLASSIFICATION only distinguishes "sibling track" from "different
 *  corridor", and around island platforms parallel tracks legitimately
 *  spread to 20-40 m for 300-600 m — those station throats must stay twins
 *  (they'd otherwise form a contiguous non-twin run that trips
 *  `WALK_TWIN_MAX_NONTWIN_RUN_M`), while a genuine second corridor (Praha
 *  Vršovice-Libeň shapes) sits hundreds of metres away. 50 m absorbs
 *  station throats (~50 m tops) with margin to spare against real
 *  corridors. Heading gate stays <10° (mod 180). */
export const WALK_TWIN_LATERAL_M = 50
/** Hard cap on the longest CONTIGUOUS non-twin stretch of the alt path
 *  (metres, contiguity along the alt path's own edge order — 2026-07-16 /gg
 *  fix batch item 5, alongside the length-weighted fraction above): a
 *  genuinely different corridor shows ONE long unbroken run beyond
 *  `WALK_TWIN_LATERAL_M` lateral even when enough short twin edges pad the
 *  overall fraction; with the 50 m classification radius absorbing station
 *  throats (see above), anything staying laterally distant for longer than
 *  this is a separate corridor, not a sibling track. */
export const WALK_TWIN_MAX_NONTWIN_RUN_M = 300
/** Quarantine radius for an UNLOCALIZED pair (neither endpoint snapped onto
 *  the graph — e.g. the Osoblaha narrow-gauge trains whose stations have no
 *  heavy-rail nearby): every stampable segment whose midpoint lies within
 *  this distance of the pair's straight chord is quarantined (2026-07-16
 *  Step-B refinement, plan item 2). An un-snappable pair can't localize a
 *  bounded graph search the way a snapped one can (there is no node to flood
 *  from), so its evidence is scoped by raw chord proximity instead — and,
 *  unlike the pre-refinement design, this withholding stays local to the
 *  chord's vicinity rather than suppressing the silent residual for the
 *  entire run. */
export const UNLOCALIZED_PAIR_QUARANTINE_RADIUS_M = 5000

/** Grid cell size (degrees) for every proximity index in this module: the
 *  T-junction segment-body grid, the node snap grid and the rail-stops grid.
 *  ~1.1 km at the equator — far coarser than T_JUNCTION_TOLERANCE_M (so a
 *  handful of neighbour cells always cover it) and comfortably coarser than
 *  STATION_SNAP_RADIUS_M / RAIL_STOP_EXEMPT_RADIUS_M (both 300 m), so a
 *  ±1-cell neighbourhood already suffices in the common case; the snap/stop
 *  queries still compute the exact ring needed for the caller's radius.
 *
 *  UNWRAPPED at the antimeridian: every grid cell key below is derived from
 *  RAW lat/lon degrees (`Math.floor(lat/lon / SPATIAL_INDEX_CELL_DEG)`), with
 *  no ±180° wraparound — unlike spatial.ts's DISTANCE helpers
 *  (`flatDist`/`pointToSegmentDist`/`pointToSegmentParamT`), which do wrap. A
 *  segment/node/stop straddling ±180° would land in wildly different cells on
 *  each side and never find its true neighbours. No railway in the dataset
 *  crosses it; revisit if one ever does. */
const SPATIAL_INDEX_CELL_DEG = 0.01

// ── Segment input + graph shape ─────────────────────────────────────────────

export interface RailGraphSegmentInput {
  /** Caller-stable id, e.g. `${hexId}:${rowIdx}` — stamps key off this, not
   *  off any graph-internal (post-healing) edge id. */
  key: string
  osmId: string
  /** Engine codes: 0 rail, 1 tram, 2 light_rail, 3 narrow, 4 funicular. */
  railType: number
  /** 0 main, 1 branch, 2 industrial. */
  usage: number
  /** Crossover etc.: connects topology so a route CAN pass through it, but is
   *  never itself the recipient of a stamp. */
  isTraversalOnly: boolean
  /** `ref || name || ''` — the corridor identity used to gate parallel-track
   *  spread; '' means "no reliable corridor identity", see applyParallelSpread. */
  corridorToken: string
  startLat: number
  startLon: number
  endLat: number
  endLon: number
  lengthM: number
}

export interface RailGraphNode {
  lat: number
  lon: number
}

/** One (post-healing) graph edge. May be a whole input segment (no T-junction
 *  touched it) or one sub-edge of a segment that was split — `parentKey`
 *  always identifies the ORIGINAL `RailGraphSegmentInput.key` either way. */
export interface RailGraphEdge {
  nodeA: number
  nodeB: number
  lengthM: number
  parentKey: string
  osmId: string
  railType: number
  usage: number
  isTraversalOnly: boolean
  corridorToken: string
  startLat: number
  startLon: number
  endLat: number
  endLon: number
}

export interface RailGraph {
  nodeCount: number
  edgeCount: number
  /** Original segment key -> component id. Well-defined even for a healed,
   *  multi-sub-edge segment: healing only ever connects a segment's own
   *  sub-edges to each other, so they always share one component. */
  componentOfSegmentKey: Map<string, number>
  // Internal structure consumed by rail-graph-metrics.ts (routing, parallel
  // spread, the R15/R16 detectors). Plain fields, not hidden behind a
  // private/symbol boundary, so the sibling module can build directly on top
  // of one graph instance instead of recomputing it.
  nodes: RailGraphNode[]
  edges: RailGraphEdge[]
  /** node id -> incident edge indices (both directions). */
  adjacency: number[][]
  /** node id -> component id, computed over the FULL healed edge set
   *  (every railType, including traversal-only) — a topological fact about
   *  the physical network, independent of which edges a given walk may
   *  route through. */
  componentOfNode: Int32Array
  /** grid cell ("latCell_lonCell") -> node ids, for snap queries. */
  nodeGrid: Map<string, number[]>
}

// ── Construction ─────────────────────────────────────────────────────────────

interface WorkEdge {
  nodeA: number
  nodeB: number
  lengthM: number
  parentKey: string
  osmId: string
  railType: number
  usage: number
  isTraversalOnly: boolean
  corridorToken: string
  startLat: number
  startLon: number
  endLat: number
  endLon: number
}

function gridCellsForBbox(minLat: number, minLon: number, maxLat: number, maxLon: number): string[] {
  const cells: string[] = []
  const laMin = Math.floor(minLat / SPATIAL_INDEX_CELL_DEG)
  const laMax = Math.floor(maxLat / SPATIAL_INDEX_CELL_DEG)
  const loMin = Math.floor(minLon / SPATIAL_INDEX_CELL_DEG)
  const loMax = Math.floor(maxLon / SPATIAL_INDEX_CELL_DEG)
  for (let la = laMin; la <= laMax; la++) {
    for (let lo = loMin; lo <= loMax; lo++) cells.push(`${la}_${lo}`)
  }
  return cells
}

/** T-junction healing (see module doc): grid-accelerated so a country-scale
 *  segment set doesn't pay an O(nodes * segments) scan. For every node, find
 *  segments whose body passes within T_JUNCTION_TOLERANCE_M and record the
 *  hit; once every node has been checked, split each touched segment at ALL
 *  its hits in one pass (collecting hits first, instead of splitting as we
 *  go, avoids the order-dependent bugs a live mutate-while-scanning approach
 *  would have — e.g. a second hit landing on a sub-edge created by the
 *  first). Sub-edges are pushed in geometric order (start -> ... -> end) so
 *  a caller can reconstruct one segment's overall geometry by taking the
 *  first and last sub-edge with its `parentKey` (see rail-graph-metrics.ts's
 *  `collectSegmentGeometry`). */
function healTJunctions(nodes: RailGraphNode[], workEdges: WorkEdge[]): RailGraphEdge[] {
  const segmentGrid = new Map<string, number[]>()
  workEdges.forEach((e, idx) => {
    const minLat = Math.min(e.startLat, e.endLat), maxLat = Math.max(e.startLat, e.endLat)
    const minLon = Math.min(e.startLon, e.endLon), maxLon = Math.max(e.startLon, e.endLon)
    for (const cell of gridCellsForBbox(minLat, minLon, maxLat, maxLon)) {
      const arr = segmentGrid.get(cell)
      if (arr) arr.push(idx); else segmentGrid.set(cell, [idx])
    }
  })

  const hits = new Map<number, Array<{ nodeId: number; t: number }>>()
  for (let nodeId = 0; nodeId < nodes.length; nodeId++) {
    const { lat, lon } = nodes[nodeId]
    const cy = Math.floor(lat / SPATIAL_INDEX_CELL_DEG)
    const cx = Math.floor(lon / SPATIAL_INDEX_CELL_DEG)
    const candidates = new Set<number>()
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = segmentGrid.get(`${cy + dy}_${cx + dx}`)
        if (arr) for (const idx of arr) candidates.add(idx)
      }
    }
    for (const idx of candidates) {
      const e = workEdges[idx]
      if (e.nodeA === nodeId || e.nodeB === nodeId) continue // already an endpoint, not a T-junction
      const d = pointToSegmentDist(lat, lon, e.startLat, e.startLon, e.endLat, e.endLon)
      if (d > T_JUNCTION_TOLERANCE_M) continue
      const t = pointToSegmentParamT(lat, lon, e.startLat, e.startLon, e.endLat, e.endLon)
      if (t <= 1e-6 || t >= 1 - 1e-6) continue // projects onto an endpoint — nodeKey already merged this one
      const arr = hits.get(idx) ?? []
      arr.push({ nodeId, t })
      hits.set(idx, arr)
    }
  }

  const finalEdges: RailGraphEdge[] = []
  workEdges.forEach((e, idx) => {
    const hitList = hits.get(idx)
    if (!hitList || hitList.length === 0) {
      finalEdges.push({ ...e })
      return
    }
    hitList.sort((a, b) => a.t - b.t)
    const chain: Array<{ nodeId: number; t: number }> = [{ nodeId: e.nodeA, t: 0 }]
    for (const h of hitList) {
      if (Math.abs(h.t - chain[chain.length - 1].t) < 1e-9) continue // duplicate split point
      chain.push(h)
    }
    chain.push({ nodeId: e.nodeB, t: 1 })
    for (let i = 0; i < chain.length - 1; i++) {
      finalEdges.push({
        ...e,
        nodeA: chain[i].nodeId,
        nodeB: chain[i + 1].nodeId,
        lengthM: e.lengthM * (chain[i + 1].t - chain[i].t),
      })
    }
  })
  return finalEdges
}

/** BFS components over the FULL edge set (array-indexed queue — no
 *  `Array.shift()` per `enrich-roads-service-tree.ts::findComponents`'s
 *  documented reason: O(1) push/pop vs O(n) shift on a dense component). */
function computeComponents(nodeCount: number, adjacency: number[][], edges: RailGraphEdge[]): Int32Array {
  const componentOfNode = new Int32Array(nodeCount).fill(-1)
  let compId = 0
  const queue: number[] = []
  for (let start = 0; start < nodeCount; start++) {
    if (componentOfNode[start] !== -1) continue
    queue.length = 0
    queue.push(start)
    componentOfNode[start] = compId
    let head = 0
    while (head < queue.length) {
      const node = queue[head++]
      for (const edgeIdx of adjacency[node]) {
        const e = edges[edgeIdx]
        const other = e.nodeA === node ? e.nodeB : e.nodeA
        if (componentOfNode[other] === -1) {
          componentOfNode[other] = compId
          queue.push(other)
        }
      }
    }
    compId++
  }
  return componentOfNode
}

function buildNodeGrid(nodes: RailGraphNode[]): Map<string, number[]> {
  const grid = new Map<string, number[]>()
  for (let id = 0; id < nodes.length; id++) {
    const key = `${Math.floor(nodes[id].lat / SPATIAL_INDEX_CELL_DEG)}_${Math.floor(nodes[id].lon / SPATIAL_INDEX_CELL_DEG)}`
    const arr = grid.get(key)
    if (arr) arr.push(id); else grid.set(key, [id])
  }
  return grid
}

export function buildRailGraph(segments: RailGraphSegmentInput[]): RailGraph {
  const nodeIdByKey = new Map<string, number>()
  const nodes: RailGraphNode[] = []
  function internNode(lat: number, lon: number): number {
    const k = nodeKey(lat, lon)
    let id = nodeIdByKey.get(k)
    if (id === undefined) {
      id = nodes.length
      nodes.push({ lat, lon })
      nodeIdByKey.set(k, id)
    }
    return id
  }

  const workEdges: WorkEdge[] = segments.map((seg) => ({
    nodeA: internNode(seg.startLat, seg.startLon),
    nodeB: internNode(seg.endLat, seg.endLon),
    lengthM: seg.lengthM,
    parentKey: seg.key,
    osmId: seg.osmId,
    railType: seg.railType,
    usage: seg.usage,
    isTraversalOnly: seg.isTraversalOnly,
    corridorToken: seg.corridorToken,
    startLat: seg.startLat,
    startLon: seg.startLon,
    endLat: seg.endLat,
    endLon: seg.endLon,
  }))

  const edges = healTJunctions(nodes, workEdges)

  const adjacency: number[][] = Array.from({ length: nodes.length }, () => [])
  edges.forEach((e, idx) => {
    adjacency[e.nodeA].push(idx)
    if (e.nodeB !== e.nodeA) adjacency[e.nodeB].push(idx)
  })

  const componentOfNode = computeComponents(nodes.length, adjacency, edges)

  const componentOfSegmentKey = new Map<string, number>()
  for (const e of edges) {
    if (!componentOfSegmentKey.has(e.parentKey)) {
      componentOfSegmentKey.set(e.parentKey, componentOfNode[e.nodeA])
    }
  }

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    componentOfSegmentKey,
    nodes,
    edges,
    adjacency,
    componentOfNode,
    nodeGrid: buildNodeGrid(nodes),
  }
}

/** Nearest graph node to `(lat, lon)` within `maxSnapM`, or -1. Never falls
 *  back to a chord match (Key decisions: "snap failure => drop pair"); the
 *  caller (walkRailStationPairs) records the failure instead of guessing. */
export function snapToNearestRailGraphNode(
  graph: RailGraph,
  lat: number,
  lon: number,
  maxSnapM: number = STATION_SNAP_RADIUS_M,
): number {
  const latSpanM = SPATIAL_INDEX_CELL_DEG * M_PER_DEG_LAT
  const lonSpanM = SPATIAL_INDEX_CELL_DEG * M_PER_DEG_LON_EQ * Math.max(0.05, Math.cos(lat * Math.PI / 180))
  const dyMax = Math.max(1, Math.ceil(maxSnapM / latSpanM))
  const dxMax = Math.max(1, Math.ceil(maxSnapM / lonSpanM))
  const gy = Math.floor(lat / SPATIAL_INDEX_CELL_DEG)
  const gx = Math.floor(lon / SPATIAL_INDEX_CELL_DEG)
  let best = -1
  let bestDist = Infinity
  for (let dy = -dyMax; dy <= dyMax; dy++) {
    for (let dx = -dxMax; dx <= dxMax; dx++) {
      const arr = graph.nodeGrid.get(`${gy + dy}_${gx + dx}`)
      if (!arr) continue
      for (const nodeId of arr) {
        const n = graph.nodes[nodeId]
        const d = flatDist(lat, lon, n.lat, n.lon)
        if (d <= maxSnapM && d < bestDist) {
          bestDist = d
          best = nodeId
        }
      }
    }
  }
  return best
}

// ── Effective traffic (engine zero-defaulting mirror) ───────────────────────

/** Per-column class default, TS mirror of
 *  `engine/noise-compute/src/emission/railway.rs::default_traffic` — keep the
 *  two tables in sync by hand; there is no codegen link between them.
 *  `RailType::from_u8` maps ANY unrecognized code to `Rail`, so the `default`
 *  arm below covers both railType 0 and an out-of-range value on purpose. */
function defaultRailTraffic(railType: number, usage: number): [pax: number, frt: number] {
  switch (railType) {
    case 1: return [120, 0] // tram
    case 2: return [80, 0]  // light_rail
    case 3: return [10, 0]  // narrow_gauge
    case 4: return [40, 0]  // funicular
    default: // 0 = heavy rail, and the engine's from_u8 fallback for unknown codes
      switch (usage) {
        case 0: return [80, 20] // main
        case 1: return [30, 5]  // branch
        case 2: return [0, 15]  // industrial siding
        default: return [40, 10] // unknown usage
      }
  }
}

/** TS mirror of `normalize_rail`'s zero-defaulting + parallel-divisor scale:
 *  each of pax/frt independently falls back to its class default ONLY where
 *  the column itself is 0 (a real 0 is indistinguishable from "unmeasured" —
 *  this is the engine's own convention, not a choice made here), then both
 *  are divided by `max(1, parallelDivisor)`. Used by the R15/R16 detectors so
 *  they compare what the engine actually renders, not the raw stamped ints. */
export function effectiveRailTraffic(
  pax: number,
  frt: number,
  railType: number,
  usage: number,
  parallelDivisor: number,
): { pax: number; frt: number; total: number } {
  const [defPax, defFrt] = defaultRailTraffic(railType, usage)
  const divisor = Math.max(1, parallelDivisor)
  const effPax = (pax > 0 ? pax : defPax) / divisor
  const effFrt = (frt > 0 ? frt : defFrt) / divisor
  return { pax: effPax, frt: effFrt, total: effPax + effFrt }
}

// ── Rail-stops sidecar index (R15/R16 stop exemption) ───────────────────────

export interface RailStopsIndex {
  queryWithinRadius(lat: number, lon: number, radiusM: number): boolean
}

/** Grid-accelerated point-in-radius test over a rail-stops sidecar (station
 *  platforms), same cell scheme as the node/segment grids above. */
export function buildRailStopsIndex(stops: Array<{ lat: number; lon: number }>): RailStopsIndex {
  const grid = new Map<string, Array<{ lat: number; lon: number }>>()
  for (const s of stops) {
    const key = `${Math.floor(s.lat / SPATIAL_INDEX_CELL_DEG)}_${Math.floor(s.lon / SPATIAL_INDEX_CELL_DEG)}`
    const arr = grid.get(key)
    if (arr) arr.push(s); else grid.set(key, [s])
  }
  return {
    queryWithinRadius(lat: number, lon: number, radiusM: number): boolean {
      const latSpanM = SPATIAL_INDEX_CELL_DEG * M_PER_DEG_LAT
      const lonSpanM = SPATIAL_INDEX_CELL_DEG * M_PER_DEG_LON_EQ * Math.max(0.05, Math.cos(lat * Math.PI / 180))
      const dyMax = Math.max(1, Math.ceil(radiusM / latSpanM))
      const dxMax = Math.max(1, Math.ceil(radiusM / lonSpanM))
      const gy = Math.floor(lat / SPATIAL_INDEX_CELL_DEG)
      const gx = Math.floor(lon / SPATIAL_INDEX_CELL_DEG)
      for (let dy = -dyMax; dy <= dyMax; dy++) {
        for (let dx = -dxMax; dx <= dxMax; dx++) {
          const arr = grid.get(`${gy + dy}_${gx + dx}`)
          if (!arr) continue
          for (const s of arr) {
            if (flatDist(lat, lon, s.lat, s.lon) <= radiusM) return true
          }
        }
      }
      return false
    },
  }
}

// ── Types shared with rail-graph-metrics.ts (route/auditor inputs+outputs) ──

export interface RailStationPairCount {
  fromLat: number
  fromLon: number
  toLat: number
  toLon: number
  pax: number
  frt: number
  /** [lat, lon]; soft corridor constraint when present (GTFS `shapes.txt`). */
  shapePolyline?: Array<[number, number]>
}

export interface RailWalkResult {
  stampsBySegmentKey: Map<string, { pax: number; frt: number; divisor: number }>
  /** Parallel-track divisor for EVERY stampable segment that has >=1 sibling
   *  (`applyParallelSpread`'s sibling probe), INDEPENDENT of `stampsBySegmentKey`
   *  — a segment can have a sibling and carry zero traffic from either side
   *  (both unwalked) and still needs its divisor recorded, or a silent-residual
   *  stamp landing there later would render at the wrong (undivided) count.
   *  Absent key = no sibling found = divisor 1 (rail-walk-enrich.ts's silent
   *  branch reads this with `?? 1`). */
  divisorBySegmentKey: Map<string, number>
  failures: { snapFailed: number; disconnected: number; detourRejected: number; ambiguous: number }
  failedPairChords: Array<{
    fromLat: number; fromLon: number; toLat: number; toLon: number
    reason: 'snapFailed' | 'disconnected' | 'detourRejected' | 'ambiguous'
  }>
  /** Component ids touched by ANY failed pair — STATS ONLY (2026-07-16
   *  Step-B refinement). Per-component granularity quarantined the WHOLE
   *  connected network wherever rail forms one component: Step-A live-run
   *  evidence found 9 failed components — including the entire CZ mainline,
   *  31 245 km — behind only 150 failed pairs out of 2 461 (rail is one
   *  connected component nationwide, so any single failed pair withheld
   *  retract/silent everywhere). Retract and the silent residual
   *  (rail-walk-enrich.ts) now key off `quarantinedSegmentKeys` — the pair's
   *  OWN bounded search ellipse — instead; this field survives only for
   *  `perComponentFailedKm` comparison logging (deprecated). */
  failedComponents: Set<number>
  /** Every stampable segment (`RailGraphSegmentInput.key`) inside a FAILED
   *  pair's own evidence region — strictly tighter than `failedComponents`
   *  (2026-07-16 Step-B refinement + /gg fix batch item 4 + review round).
   *  The shape follows the FAILURE REASON, all built from THAT PAIR's own
   *  `WALK_DETOUR_RATIO * greatCircle + WALK_DETOUR_SLACK_M` bound (the same
   *  bound `detourRejected` enforces):
   *  'ambiguous' -> the true admissible-path ellipse (a segment qualifies
   *  only when min over its two endpoints of distFrom+distTo is within the
   *  bound) — admissible corridors exist, the walk just can't pick one.
   *  'detourRejected' / 'disconnected' -> endpoint-radius balls around BOTH
   *  snapped ends: no admissible path exists (the ellipse would be empty),
   *  yet the timetable's trains run somewhere near these stations — the
   *  GRAPH is what failed, so silent/retract must stay away from both
   *  vicinities (Čelákovice–Čelákovice zastávka: a detour-rejected commuter
   *  line must not go silent at 2+1/day).
   *  'snapFailed' with ONE end snapped -> the ball around that end (the far
   *  end is unknown). NEITHER end snapped -> every stampable segment within
   *  `UNLOCALIZED_PAIR_QUARANTINE_RADIUS_M` of the pair's straight chord.
   *  Retract and the silent residual (rail-walk-enrich.ts) withhold on
   *  SEGMENT membership here, never on the segment's whole component. */
  quarantinedSegmentKeys: Set<string>
  /** Pairs where NEITHER endpoint snapped onto the graph (both ends failed
   *  `snapToNearestRailGraphNode`) — quarantined via the chord-vicinity
   *  radius above (there is no node to flood a bounded search from), NOT by
   *  suppressing the silent residual globally (2026-07-16 Step-B refinement
   *  dropped that semantics — it quarantined entire clean runs behind one
   *  unrelated stray pair). This count is stats-only telemetry now. */
  unlocalizedPairs: number
  pairsWalked: number
  pairsTotal: number
}

export interface RailEndpointRow {
  key: string
  osmId: string
  railType: number
  usage: number
  service: number
  sourceId: number
  pax: number
  frt: number
  parallelDivisor: number
  startLat: number
  startLon: number
  endLat: number
  endLon: number
}

export interface RailContinuityViolation {
  endpointLat: number
  endpointLon: number
  aKey: string
  bKey: string
  aSourceId: number
  bSourceId: number
  ratio: number
  effA: { pax: number; frt: number; total: number }
  effB: { pax: number; frt: number; total: number }
  column: 'pax' | 'frt' | 'total'
}

/** The rail-stops sidecar on disk (`data/prepared/{year}/rail-stops/{scope}.json`)
 *  — written by exactly one writer (`rail-walk-enrich.ts`'s
 *  `writeStopsSidecarIfAny`) and read by exactly one reader
 *  (`rail-endpoint-rows.ts`'s `loadRailStopsIndex`, the R15/R16 stop
 *  exemption). Types live here (rail-graph.ts is the types home) so writer
 *  and reader can never drift on the envelope shape. */
export interface RailStopsSidecarV1 {
  version: 1
  year: string
  scope: string
  extractFingerprint: string
  feeds: string[]
  generatedAt: string
  stops: Array<{ lat: number; lon: number }>
}
