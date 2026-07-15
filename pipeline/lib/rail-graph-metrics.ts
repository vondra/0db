/**
 * Rail graph-walk routing + parallel-track spread + the R15/R16 continuity
 * detectors — split out of `rail-graph.ts` to keep that file near the
 * ~300-line target. Imports ALL shared types/constants from there; no
 * topology-building logic is duplicated here (Dijkstra and the detectors
 * read `RailGraph`'s internals, they never recompute them).
 *
 * `walkRailStationPairs` is the matcher's core: canonical-pair accumulation,
 * bounded shortest-path search (optionally shape-constrained), an ambiguity
 * probe, then a PER-SEGMENT parallel-track spread. The spread's lateral
 * point-to-body metric and per-segment divisor replace the round-1
 * transitive-cluster/clique grouping (2026-07-15 review round 2): the
 * midpoint-distance metric was stagger-blind — microsegments are cut
 * independently per OSM way, so parallel tracks carry arbitrary 0-250 m
 * longitudinal midpoint offsets — and with any correct lateral metric,
 * transitive clusters chain A1-B1-A2-B2... down the whole corridor, after
 * which the clique test always fails. See `applyParallelSpread`.
 *
 * `findRailFlowJumps` (R15) and `findRailContinuityGaps` (R16) are the rail
 * twins of the road auditor's R5 flow-jump / R13 continuity-gap
 * (`audit-enrichment-invariants.ts`), reworked to compare EFFECTIVE traffic
 * (`effectiveRailTraffic`) across source ids instead of raw AADT within one
 * source — a raw 16+0 vs 2+1 misses the >=20/day floor entirely, but the
 * engine actually renders 36 vs 3 once zero-defaulting applies.
 */

import { nodeKey, haversineM, pointToSegmentDist, pointToPolylineDist, coordKey4dp, wrapLonDeltaDeg, M_PER_DEG_LAT, M_PER_DEG_LON_EQ } from './spatial.js'
import { MinHeap } from './min-heap.js'
import {
  type RailGraph, type RailGraphEdge, type RailStationPairCount, type RailWalkResult,
  type RailStopsIndex, type RailEndpointRow, type RailContinuityViolation,
  effectiveRailTraffic, snapToNearestRailGraphNode,
  WALK_DETOUR_RATIO, WALK_DETOUR_SLACK_M, WALK_AMBIGUITY_LENGTH_RATIO, WALK_AMBIGUITY_SHARED_EDGE_FRACTION,
  SHAPE_CORRIDOR_TOLERANCE_M, PARALLEL_SPREAD_RADIUS_M, RAIL_JUMP_RATIO, RAIL_MIN_EFFECTIVE_TRAINS_PER_DAY,
  RAIL_STOP_EXEMPT_RADIUS_M,
} from './rail-graph.js'

// ── Bounded shortest path ────────────────────────────────────────────────────

/** Only rail_type=0 (heavy rail) edges + traversal-only edges (crossovers)
 *  ever participate in a walk — a tram/light_rail/narrow/funicular edge
 *  can neither carry nor bridge a heavy-rail station-pair count. */
function isRoutable(e: RailGraphEdge): boolean {
  return e.isTraversalOnly || e.railType === 0
}

interface ShortestPathResult { lengthM: number; edgeIndices: Set<number> }

/** Reusable Dijkstra scratch buffers, sized to ONE graph's `nodeCount`. REAL
 *  scale blocker this fixes: a Europe union graph (~5M nodes) x ~1e5 station
 *  pairs x 2 searches per pair (best path + the ambiguity probe's penalized
 *  re-run) would spend ~1e12 ops just re-filling `dist`/`prevEdge`/`prevNode`/
 *  `visited` from scratch on every call. `walkRailStationPairs` allocates ONE
 *  scratch per graph and threads it through every search on that graph;
 *  `touched` is how a search's cleanup cost scales with what IT visited,
 *  never with `nodeCount`. */
export interface DijkstraScratch {
  dist: Float64Array
  prevEdge: Int32Array
  prevNode: Int32Array
  visited: Uint8Array
  /** Node ids written by the search IN PROGRESS — drained (and used to reset
   *  the four arrays above) at the START of the next call that reuses this
   *  scratch, so a leftover value from a previous search can never leak into
   *  the next one. */
  touched: number[]
}

export function createDijkstraScratch(nodeCount: number): DijkstraScratch {
  return {
    dist: new Float64Array(nodeCount).fill(Infinity),
    prevEdge: new Int32Array(nodeCount).fill(-1),
    prevNode: new Int32Array(nodeCount).fill(-1),
    visited: new Uint8Array(nodeCount),
    touched: [],
  }
}

function resetDijkstraScratch(scratch: DijkstraScratch): void {
  for (const node of scratch.touched) {
    scratch.dist[node] = Infinity
    scratch.prevEdge[node] = -1
    scratch.prevNode[node] = -1
    scratch.visited[node] = 0
  }
  scratch.touched.length = 0
}

/** Dijkstra with an injectable edge weight (so the ambiguity probe can
 *  penalize the best path's own edges 3x without a second graph copy) and an
 *  optional edge filter (the shape-polyline soft corridor constraint).
 *  `lengthM` on the result is always the TRUE physical length recomputed
 *  from `edge.lengthM` during backtrack — independent of whatever weight
 *  function drove the search — so a penalized re-run still reports a
 *  comparable real-world distance.
 *
 *  `scratch`: pass one from `createDijkstraScratch` to reuse its buffers
 *  across many searches on the SAME graph (only the cells the PREVIOUS
 *  search touched are reset, never the full `nodeCount`-sized arrays) —
 *  omit it to allocate a throwaway scratch for one standalone call. Passing
 *  a scratch never changes the result, only where the buffers come from. */
export function dijkstraShortestPath(
  graph: RailGraph,
  fromNode: number,
  toNode: number,
  edgeFilter: ((edge: RailGraphEdge) => boolean) | null,
  edgeWeight: (edgeIdx: number, edge: RailGraphEdge) => number,
  scratch?: DijkstraScratch,
): ShortestPathResult | null {
  if (scratch) resetDijkstraScratch(scratch)
  const { dist, prevEdge, prevNode, visited } = scratch ?? createDijkstraScratch(graph.nodeCount)
  const touch = (node: number): void => { if (scratch) scratch.touched.push(node) }

  dist[fromNode] = 0
  touch(fromNode)
  const heap = new MinHeap()
  heap.push(0, fromNode)

  while (heap.size > 0) {
    const { dist: d, node } = heap.pop()
    if (visited[node]) continue
    visited[node] = 1
    if (node === toNode) break
    for (const edgeIdx of graph.adjacency[node]) {
      const e = graph.edges[edgeIdx]
      if (!isRoutable(e)) continue
      if (edgeFilter && !edgeFilter(e)) continue
      const other = e.nodeA === node ? e.nodeB : e.nodeA
      if (visited[other]) continue
      const nd = d + edgeWeight(edgeIdx, e)
      if (nd < dist[other]) {
        if (dist[other] === Infinity) touch(other) // first time this search reaches `other`
        dist[other] = nd
        prevEdge[other] = edgeIdx
        prevNode[other] = node
        heap.push(nd, other)
      }
    }
  }

  if (dist[toNode] === Infinity) return null

  const edgeIndices = new Set<number>()
  let lengthM = 0
  let cur = toNode
  while (cur !== fromNode) {
    const edgeIdx = prevEdge[cur]
    if (edgeIdx === -1) return null // defensive: should be unreachable given dist[toNode] finite
    edgeIndices.add(edgeIdx)
    lengthM += graph.edges[edgeIdx].lengthM
    cur = prevNode[cur]
  }
  return { lengthM, edgeIndices }
}

// ── Parallel-track spread ────────────────────────────────────────────────────

/** Track pairs in a shared corridor sit 4-10 m apart; two DISTINCT parallel
 *  lines are typically wider. When no corridor token can confirm identity
 *  (CZ evidence 2026-07-15: 0 of ~5,000 corridor segments carry ref or name),
 *  this much tighter radius + the 10-degree heading gate below stand in for
 *  the token — /gg review W8: tighten bearing/overlap instead of removing
 *  the token-less arm, else no CZ double-track ever spreads and the divided
 *  twin renders at the full engine class default (the DE +8..+17 dB
 *  double-count shape, plan /gg item 6). */
export const PARALLEL_SPREAD_TOKENLESS_RADIUS_M = 15

/** Overlap-fraction gate (2026-07-16 /gg review, item 7): segment `i` counts
 *  `j` as a sibling only when their longitudinal overlap covers at least this
 *  many metres — see `PARALLEL_SPREAD_MIN_OVERLAP_FRACTION` for the other
 *  (percentage) arm and `longitudinalOverlapM`'s doc for the accepted
 *  asymmetric-residual bound this trades off against exact conservation. */
export const PARALLEL_SPREAD_MIN_OVERLAP_ABS_M = 30
/** ...OR at least this fraction of `i`'s OWN length, whichever is larger. */
export const PARALLEL_SPREAD_MIN_OVERLAP_FRACTION = 0.3

interface SegGeom {
  railType: number
  usage: number
  osmId: string
  isTraversalOnly: boolean
  corridorToken: string
  startLat: number; startLon: number; endLat: number; endLon: number
  nodeA: number; nodeB: number
}

/** Reconstructs one ORIGINAL segment's overall geometry from its (possibly
 *  many, post-healing) sub-edges. Relies on `healTJunctions` pushing an
 *  input segment's sub-edges contiguously in geometric order (see
 *  rail-graph.ts) — first-seen start + running end reproduce the full span
 *  without needing the original un-healed segment list. */
function collectSegmentGeometry(graph: RailGraph): Map<string, SegGeom> {
  const map = new Map<string, SegGeom>()
  for (const e of graph.edges) {
    let g = map.get(e.parentKey)
    if (!g) {
      g = {
        railType: e.railType, usage: e.usage, osmId: e.osmId, isTraversalOnly: e.isTraversalOnly,
        corridorToken: e.corridorToken,
        startLat: e.startLat, startLon: e.startLon, endLat: e.endLat, endLon: e.endLon,
        nodeA: e.nodeA, nodeB: e.nodeB,
      }
      map.set(e.parentKey, g)
    }
    g.endLat = e.endLat
    g.endLon = e.endLon
    g.nodeB = e.nodeB
  }
  return map
}

/** Compass heading (degrees, 0-360) of a->b using the same flat-earth
 *  projection as spatial.ts, including its antimeridian wrap (a corridor
 *  straddling ±180° must not compute a ~180°-off heading from the raw
 *  unwrapped delta). Only ever compared mod 180 (see headingDeltaMod180), so
 *  a-b vs b-a direction never matters. */
function headingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cosLat = Math.cos(((aLat + bLat) / 2) * Math.PI / 180)
  const dx = wrapLonDeltaDeg(bLon - aLon) * M_PER_DEG_LON_EQ * cosLat
  const dy = (bLat - aLat) * M_PER_DEG_LAT
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360
}

function headingDeltaMod180(h1: number, h2: number): number {
  const diff = Math.abs(h1 - h2) % 180
  return Math.min(diff, 180 - diff)
}

/** Projects both segments onto the shared heading axis (local flat-earth
 *  metres around their common midpoint) and returns the longitudinal OVERLAP
 *  length in metres (0 = spans don't touch at all), plus `a`'s own span —
 *  the caller gates on a FRACTION of `a`'s length (see
 *  `parallelSiblingLateralM`'s doc for why this is deliberately asymmetric,
 *  and `applyParallelSpread`'s doc for the accepted error this trades off
 *  against exact conservation). Two parallel-heading tracks that don't
 *  actually run alongside each other (one ends where the other starts) have
 *  zero overlap and are never siblings. */
function longitudinalOverlapM(a: SegGeom, b: SegGeom): { overlapM: number; aSpanM: number } {
  const midLat = (a.startLat + a.endLat + b.startLat + b.endLat) / 4
  const cosLat = Math.cos(midLat * Math.PI / 180)
  const headingRad = headingDeg(a.startLat, a.startLon, a.endLat, a.endLon) * Math.PI / 180
  const ux = Math.sin(headingRad), uy = Math.cos(headingRad) // unit vector, matches atan2(dx,dy) convention
  const scalar = (lat: number, lon: number) => {
    const x = lon * M_PER_DEG_LON_EQ * cosLat
    const y = lat * M_PER_DEG_LAT
    return x * ux + y * uy
  }
  const aMin = Math.min(scalar(a.startLat, a.startLon), scalar(a.endLat, a.endLon))
  const aMax = Math.max(scalar(a.startLat, a.startLon), scalar(a.endLat, a.endLon))
  const bMin = Math.min(scalar(b.startLat, b.startLon), scalar(b.endLat, b.endLon))
  const bMax = Math.max(scalar(b.startLat, b.startLon), scalar(b.endLat, b.endLon))
  const overlapM = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin))
  return { overlapM, aSpanM: aMax - aMin }
}

/** Sibling probe (plan Phase 1 point 6 + 2026-07-15 review round 2): does
 *  `b` run alongside `a` at a's midpoint? Returns the LATERAL distance
 *  (metres, a-midpoint -> BODY of b) when every gate passes, else null.
 *
 *  Point-to-BODY is the load-bearing metric choice: microsegments are cut
 *  independently per OSM way (up to 250 m, cut phase anchored at each way's
 *  own start — engine/osm-extract/src/microsegment.rs), so two physically
 *  parallel tracks carry arbitrary 0-250 m longitudinal midpoint stagger. A
 *  midpoint-to-midpoint gate (the round-1 design here, and the old CZ
 *  czpttKey divisor pass before it) never pairs a staggered double-track at
 *  all — the sibling then renders at the full engine class default (the DE
 *  +8..+17 dB divisor-coverage hole). Distance to b's body is stagger-immune.
 *
 *  Gates: different osmId, same railType+usage, no shared node (a spur
 *  meeting the main is not a sibling), then one of two geometry arms:
 *  - CONFIRMED tokens (both non-empty and equal): lateral within
 *    PARALLEL_SPREAD_RADIUS_M (50 m), heading within 20 deg (mod 180),
 *    longitudinal overlap — the original matcher design.
 *  - TOKEN-LESS (either token empty): the STRICT arm — lateral within
 *    PARALLEL_SPREAD_TOKENLESS_RADIUS_M (15 m), heading within 10 deg,
 *    longitudinal overlap. See the constant's comment for the provenance
 *    (/gg W8 + the CZ empty-token evidence).
 *  - Tokens non-empty but DIFFERENT: never siblings — two named corridors
 *    that happen to run alongside stay independent.
 *  - Longitudinal overlap must cover >= max(30 m, 30% of `a`'s OWN length)
 *    (2026-07-16 /gg review, item 7) — a segment barely grazing a much
 *    longer neighbour's end is not a real double-track pairing from ITS
 *    perspective. This is DELIBERATELY asymmetric (see
 *    `applyParallelSpread`'s doc for the accepted-error bound it trades off
 *    against exact conservation): a short segment can accept a long one that
 *    only just touches it, while the long one rejects the short one back. */
function parallelSiblingLateralM(a: SegGeom, aMidLat: number, aMidLon: number, b: SegGeom): number | null {
  if (a.osmId === b.osmId) return null
  if (a.railType !== b.railType || a.usage !== b.usage) return null
  if (a.nodeA === b.nodeA || a.nodeA === b.nodeB || a.nodeB === b.nodeA || a.nodeB === b.nodeB) return null
  if (a.corridorToken !== '' && b.corridorToken !== '' && a.corridorToken !== b.corridorToken) return null
  const tokenConfirmed = a.corridorToken !== '' && a.corridorToken === b.corridorToken
  const maxLateralM = tokenConfirmed ? PARALLEL_SPREAD_RADIUS_M : PARALLEL_SPREAD_TOKENLESS_RADIUS_M
  const maxHeadingDeltaDeg = tokenConfirmed ? 20 : 10
  const hA = headingDeg(a.startLat, a.startLon, a.endLat, a.endLon)
  const hB = headingDeg(b.startLat, b.startLon, b.endLat, b.endLon)
  if (headingDeltaMod180(hA, hB) >= maxHeadingDeltaDeg) return null
  const { overlapM, aSpanM } = longitudinalOverlapM(a, b)
  if (overlapM < Math.max(PARALLEL_SPREAD_MIN_OVERLAP_ABS_M, PARALLEL_SPREAD_MIN_OVERLAP_FRACTION * aSpanM)) return null
  const lateralM = pointToSegmentDist(aMidLat, aMidLon, b.startLat, b.startLon, b.endLat, b.endLon)
  if (lateralM >= maxLateralM) return null
  return lateralM
}

/** Grid cell for the sibling candidate search. ~110 m of latitude — segment
 *  BODIES are indexed by their bbox cells (a 250 m microsegment spans a
 *  handful), the query ring around a midpoint is computed latitude-aware per
 *  query, so a body within the 50 m search radius always shares a ring cell.
 *  UNWRAPPED at the antimeridian, like rail-graph.ts's SPATIAL_INDEX_CELL_DEG
 *  grids (same reasoning: no railway segment in the dataset crosses ±180°;
 *  revisit if one ever does). */
const PARALLEL_GRID_CELL_DEG = 0.001

/** PER-SEGMENT parallel-track spread (2026-07-15 review round 2 — REPLACES
 *  the round-1 transitive-cluster + clique grouping: once the sibling metric
 *  is stagger-immune, cluster growth chains A1-B1-A2-B2... down the whole
 *  corridor and the clique test then ALWAYS fails, because far members never
 *  longitudinally overlap — corridor-global grouping cannot express a
 *  divisor that varies along the line; the grouping must be local).
 *
 *  For every stampable segment i (heavy rail, not traversal-only — stamped
 *  or NOT: a canonical pair is walked once along ONE shortest path, so on a
 *  double-track only one track ever carries the walk's stamp, and the
 *  sibling must still be reached or it falls to the engine class default):
 *  1. siblings(i) = ONE representative per OTHER osmId — the laterally
 *     nearest segment passing `parallelSiblingLateralM` at i's midpoint.
 *  2. No siblings -> row untouched (stamps AND divisorBySegmentKey stay
 *     absent for i).
 *  3. divisor_i = 1 + number of distinct sibling osmIds — recorded into
 *     `divisorBySegmentKey` for EVERY i with >=1 sibling, INDEPENDENT of
 *     whether i or its siblings carry any traffic (a silent-residual stamp
 *     landing later on an unwalked-but-sibling-bearing row still needs the
 *     right divisor, not an implicit 1 — 2026-07-16 /gg review item 2).
 *  4. value_i = preSpread(i) + sum of preSpread(representative_j), ALL read
 *     from a FROZEN pre-spread snapshot — never post-spread values, so a
 *     spread result can never feed a second spread (no double counting).
 *  5. value 0 (fully unstamped neighbourhood) stays absent from `stamps`
 *     even though `divisorBySegmentKey` still records the divisor (step 3).
 *
 *  CONSERVATION (typical case): at any corridor cross-section with N tracks
 *  and pre-spread stamps T_1..T_N (some 0), every track sees the other N-1 as
 *  siblings, so each carries value = sum(T) with divisor = N and renders
 *  sum(T)/N — the cross-section total is sum(T), exactly the single-track
 *  total. The divisor is position-local: a third track joining mid-corridor
 *  raises the divisor to 3 only on the segments it actually overlaps, 2
 *  elsewhere.
 *
 *  ACCEPTED ERROR (2026-07-16 /gg review item 7 — NOT exact conservation
 *  everywhere): the overlap-fraction gate in `parallelSiblingLateralM`
 *  (segment i counts j as a sibling only when their longitudinal overlap
 *  covers >= max(30 m, 30% of i's OWN length)) is deliberately asymmetric —
 *  a SHORT segment barely touching a much LONGER neighbour's end can accept
 *  it as a sibling (the overlap is a big fraction of the short one) while the
 *  long segment rejects the short one back (the same overlap is a small
 *  fraction of ITS length). Repro: A spans 0-250 m (stamped T), B spans
 *  200-300 m (parallel, unstamped) — B (100 m) sees a 50 m/50% overlap with A
 *  and accepts it (divisor 2, value T, renders T/2); A (250 m) sees the same
 *  50 m as only 20% of its own length and rejects B (divisor 1, renders T/1
 *  unchanged) — so the 50 m sliver shows T/1 on one track and T/2 on the
 *  other, up to +1.76 dB over-rendered versus the "should be T/2 on both"
 *  ideal. Exact conservation would require SPLITTING Arrow rows at every
 *  overlap boundary — rejected per SPEC's Occam's-razor rule: the bug class
 *  this pass fixes was a ~12 dB double-count over KILOMETRES of banded
 *  corridor, and a <=250 m sliver at <=1.76 dB is not worth the row-splitting
 *  complexity to close. */
function applyParallelSpread(
  graph: RailGraph,
  stamps: Map<string, { pax: number; frt: number; divisor: number }>,
  divisorBySegmentKey: Map<string, number>,
): void {
  const geomByKey = collectSegmentGeometry(graph)

  const stampableGeomByKey = new Map<string, SegGeom>()
  const bodyGrid = new Map<string, string[]>() // cell -> keys of segments whose body bbox covers the cell
  for (const [k, g] of geomByKey) {
    if (g.railType !== 0 || g.isTraversalOnly) continue // stampable universe only
    stampableGeomByKey.set(k, g)
    const laMin = Math.floor(Math.min(g.startLat, g.endLat) / PARALLEL_GRID_CELL_DEG)
    const laMax = Math.floor(Math.max(g.startLat, g.endLat) / PARALLEL_GRID_CELL_DEG)
    const loMin = Math.floor(Math.min(g.startLon, g.endLon) / PARALLEL_GRID_CELL_DEG)
    const loMax = Math.floor(Math.max(g.startLon, g.endLon) / PARALLEL_GRID_CELL_DEG)
    for (let la = laMin; la <= laMax; la++) {
      for (let lo = loMin; lo <= loMax; lo++) {
        const cell = `${la}_${lo}`
        const arr = bodyGrid.get(cell)
        if (arr) arr.push(k); else bodyGrid.set(cell, [k])
      }
    }
  }

  // FROZEN pre-spread snapshot (spec step 4). Shallow copy suffices: the
  // loop below only ever REPLACES map entries via stamps.set, never mutates
  // the existing value objects.
  const preSpread = new Map(stamps)

  for (const [key, gi] of stampableGeomByKey) {
    const midLat = (gi.startLat + gi.endLat) / 2
    const midLon = (gi.startLon + gi.endLon) / 2
    const latSpanM = PARALLEL_GRID_CELL_DEG * M_PER_DEG_LAT
    const lonSpanM = PARALLEL_GRID_CELL_DEG * M_PER_DEG_LON_EQ * Math.max(0.05, Math.cos(midLat * Math.PI / 180))
    const dyMax = Math.max(1, Math.ceil(PARALLEL_SPREAD_RADIUS_M / latSpanM))
    const dxMax = Math.max(1, Math.ceil(PARALLEL_SPREAD_RADIUS_M / lonSpanM))
    const gy = Math.floor(midLat / PARALLEL_GRID_CELL_DEG)
    const gx = Math.floor(midLon / PARALLEL_GRID_CELL_DEG)

    const probed = new Set<string>()
    const nearestSiblingByOsmId = new Map<string, { lateralM: number; key: string }>()
    for (let dy = -dyMax; dy <= dyMax; dy++) {
      for (let dx = -dxMax; dx <= dxMax; dx++) {
        const arr = bodyGrid.get(`${gy + dy}_${gx + dx}`)
        if (!arr) continue
        for (const jKey of arr) {
          if (jKey === key || probed.has(jKey)) continue
          probed.add(jKey)
          const gj = stampableGeomByKey.get(jKey)!
          const lateralM = parallelSiblingLateralM(gi, midLat, midLon, gj)
          if (lateralM === null) continue
          const prev = nearestSiblingByOsmId.get(gj.osmId)
          if (!prev || lateralM < prev.lateralM) nearestSiblingByOsmId.set(gj.osmId, { lateralM, key: jKey })
        }
      }
    }
    if (nearestSiblingByOsmId.size === 0) continue // no siblings — row untouched
    const divisor = 1 + nearestSiblingByOsmId.size
    // Recorded for EVERY sibling-bearing segment regardless of traffic (step 3
    // above) — independent of whether `stamps` itself ends up touched below.
    divisorBySegmentKey.set(key, divisor)

    const own = preSpread.get(key)
    let pax = own?.pax ?? 0
    let frt = own?.frt ?? 0
    for (const rep of nearestSiblingByOsmId.values()) {
      const s = preSpread.get(rep.key)
      if (s) { pax += s.pax; frt += s.frt } // unstamped representatives contribute 0
    }
    if (pax === 0 && frt === 0) continue // fully unstamped neighbourhood stays absent
    stamps.set(key, { pax, frt, divisor })
  }
}

// ── Canonical pair accumulation + walk ────────────────────────────────────────

interface CanonicalPair {
  fromLat: number; fromLon: number; toLat: number; toLon: number
  pax: number; frt: number
  shapePolyline?: Array<[number, number]>
}

function accumulateCanonicalPairs(pairs: RailStationPairCount[]): Map<string, CanonicalPair> {
  const byPair = new Map<string, CanonicalPair>()
  for (const p of pairs) {
    const kFrom = coordKey4dp(p.fromLat, p.fromLon)
    const kTo = coordKey4dp(p.toLat, p.toLon)
    const [kLo, kHi] = kFrom <= kTo ? [kFrom, kTo] : [kTo, kFrom]
    const canonicalKey = `${kLo}|${kHi}`
    let entry = byPair.get(canonicalKey)
    if (!entry) {
      const [fromLat, fromLon] = kLo.split(',').map(Number)
      const [toLat, toLon] = kHi.split(',').map(Number)
      entry = { fromLat, fromLon, toLat, toLon, pax: 0, frt: 0 }
      byPair.set(canonicalKey, entry)
    }
    // Directions SUM (engine wants total trains/day, both directions add) and
    // so do duplicate trips (express+local on the same OD pair).
    entry.pax += p.pax
    entry.frt += p.frt
    if (!entry.shapePolyline && p.shapePolyline) entry.shapePolyline = p.shapePolyline
  }
  return byPair
}

function shapeEdgeFilter(shapePolyline: Array<[number, number]>): (edge: RailGraphEdge) => boolean {
  const lonLatCoords: Array<[number, number]> = shapePolyline.map(([lat, lon]) => [lon, lat])
  return (edge: RailGraphEdge) => {
    const midLat = (edge.startLat + edge.endLat) / 2
    const midLon = (edge.startLon + edge.endLon) / 2
    return pointToPolylineDist(midLat, midLon, lonLatCoords) <= SHAPE_CORRIDOR_TOLERANCE_M
  }
}

export function walkRailStationPairs(graph: RailGraph, pairs: RailStationPairCount[]): RailWalkResult {
  const stampsBySegmentKey = new Map<string, { pax: number; frt: number; divisor: number }>()
  const divisorBySegmentKey = new Map<string, number>()
  const failures = { snapFailed: 0, disconnected: 0, detourRejected: 0, ambiguous: 0 }
  const failedPairChords: RailWalkResult['failedPairChords'] = []
  const failedComponents = new Set<number>()
  // A pair where NEITHER end snapped could belong to ANY component — unlike a
  // one-end-snapped failure (attributable to the component that DID
  // resolve), it can't be localized at all. Counted separately so downstream
  // callers (rail-walk-enrich.ts) can withhold silent-residual eligibility
  // GLOBALLY when this is nonzero, rather than trusting failedComponents to
  // have caught it (2026-07-16 /gg review item 4).
  let unlocalizedPairs = 0

  const canonicalPairs = accumulateCanonicalPairs(pairs)
  const pairsTotal = canonicalPairs.size
  let pairsWalked = 0

  // ONE scratch for every search over this graph (see DijkstraScratch doc) —
  // a country/world union graph runs up to two searches (best path + the
  // ambiguity probe's penalized re-run) per canonical pair, and re-allocating
  // nodeCount-sized arrays that many times is the real scale blocker.
  const scratch = createDijkstraScratch(graph.nodeCount)

  for (const cp of canonicalPairs.values()) {
    const fail = (reason: RailWalkResult['failedPairChords'][number]['reason']) => {
      failures[reason]++
      failedPairChords.push({ fromLat: cp.fromLat, fromLon: cp.fromLon, toLat: cp.toLat, toLon: cp.toLon, reason })
    }

    const fromNode = snapToNearestRailGraphNode(graph, cp.fromLat, cp.fromLon)
    const toNode = snapToNearestRailGraphNode(graph, cp.toLat, cp.toLon)
    if (fromNode === -1 || toNode === -1) {
      // Add the component of EVERY end that DID snap — a one-end-snapped pair
      // still localizes evidence to that side's component, and must withhold
      // silent/retract there exactly like 'disconnected'/'detourRejected' do.
      if (fromNode !== -1) failedComponents.add(graph.componentOfNode[fromNode])
      if (toNode !== -1) failedComponents.add(graph.componentOfNode[toNode])
      if (fromNode === -1 && toNode === -1) unlocalizedPairs++
      fail('snapFailed')
      continue
    }

    if (graph.componentOfNode[fromNode] !== graph.componentOfNode[toNode]) {
      failedComponents.add(graph.componentOfNode[fromNode])
      failedComponents.add(graph.componentOfNode[toNode])
      fail('disconnected')
      continue
    }

    const shapeFilter = cp.shapePolyline ? shapeEdgeFilter(cp.shapePolyline) : null
    const best = dijkstraShortestPath(graph, fromNode, toNode, shapeFilter, (_i, e) => e.lengthM, scratch)
    if (!best) {
      // Same topological component (checked above, over ALL edges including
      // traversal-only) yet no route through routable edges alone — folded
      // into 'disconnected' rather than inventing a 5th failure category for
      // what is, practically, the same class of problem at a finer grain.
      failedComponents.add(graph.componentOfNode[fromNode])
      fail('disconnected')
      continue
    }

    const greatCircleM = haversineM(cp.fromLat, cp.fromLon, cp.toLat, cp.toLon)
    const bound = WALK_DETOUR_RATIO * greatCircleM + WALK_DETOUR_SLACK_M
    if (best.lengthM > bound) {
      failedComponents.add(graph.componentOfNode[fromNode])
      fail('detourRejected')
      continue
    }

    // Ambiguity proxy (spec step 4): penalize the best path's own edges 3x and
    // re-run. If an alternate route still completes within 20% of the best
    // path's TRUE length while reusing less than half its edges, the walk
    // cannot tell which corridor should carry the count — fail rather than
    // guess. Skipped entirely when a shape polyline already constrained the
    // search (the shape IS the disambiguation).
    if (!cp.shapePolyline) {
      const alt = dijkstraShortestPath(
        graph, fromNode, toNode, null,
        (edgeIdx, e) => e.lengthM * (best.edgeIndices.has(edgeIdx) ? 3 : 1),
        scratch,
      )
      if (alt) {
        let shared = 0
        for (const idx of alt.edgeIndices) if (best.edgeIndices.has(idx)) shared++
        const sharedFraction = best.edgeIndices.size === 0 ? 1 : shared / best.edgeIndices.size
        if (alt.lengthM <= WALK_AMBIGUITY_LENGTH_RATIO * best.lengthM && sharedFraction < WALK_AMBIGUITY_SHARED_EDGE_FRACTION) {
          failedComponents.add(graph.componentOfNode[fromNode])
          fail('ambiguous')
          continue
        }
      }
    }

    pairsWalked++
    const stampableKeysOnPath = new Set<string>()
    for (const edgeIdx of best.edgeIndices) {
      const e = graph.edges[edgeIdx]
      if (e.isTraversalOnly || e.railType !== 0) continue // crossovers/other families connect, never stamped
      stampableKeysOnPath.add(e.parentKey)
    }
    // Dedup by ORIGINAL segment key before adding: a T-junction-healed
    // segment can contribute two sub-edges to one path (straight through the
    // junction) — without this de-dup the same original segment would be
    // credited twice for one pair.
    for (const key of stampableKeysOnPath) {
      const existing = stampsBySegmentKey.get(key) ?? { pax: 0, frt: 0, divisor: 1 }
      existing.pax += cp.pax
      existing.frt += cp.frt
      stampsBySegmentKey.set(key, existing)
    }
  }

  applyParallelSpread(graph, stampsBySegmentKey, divisorBySegmentKey)

  return {
    stampsBySegmentKey, divisorBySegmentKey, failures, failedPairChords, failedComponents,
    unlocalizedPairs, pairsWalked, pairsTotal,
  }
}

// ── R15/R16: cross-source continuity detectors ──────────────────────────────

/** Shared endpoint bookkeeping for both detectors, built in ONE pass over
 *  `rows` and memoized per-rows-array-identity: `touchCount` counts EVERY
 *  heavy-rail non-service touch at a node (junction exemption — >=3 such
 *  touches means a real junction, since the pair itself already accounts for
 *  2); `r15ByEndpoint`/`r16ByEndpoint` collect the rows each detector's own
 *  candidate filter wants paired up (R15: usage<=1 && sourceId>0; R16:
 *  usage<=1). Both real call sites (audit-enrichment-invariants.ts,
 *  enrichment-status.ts) invoke `findRailFlowJumps` immediately followed by
 *  `findRailContinuityGaps` on the SAME rows array — without this memo,
 *  `touchCount` (byte-identical either way) would be rebuilt from scratch a
 *  second time over what can be millions of rows. A WeakMap keyed on the
 *  array itself needs no cache-invalidation logic: it can never outlive the
 *  array, and a caller building a fresh rows array for a re-run gets a fresh
 *  entry for free. */
interface EndpointCandidates {
  touchCount: Map<string, number>
  r15ByEndpoint: Map<string, RailEndpointRow[]>
  r16ByEndpoint: Map<string, RailEndpointRow[]>
}

const endpointCandidatesMemo = new WeakMap<readonly RailEndpointRow[], EndpointCandidates>()

function endpointCandidatesFor(rows: readonly RailEndpointRow[]): EndpointCandidates {
  const cached = endpointCandidatesMemo.get(rows)
  if (cached) return cached

  const touchCount = new Map<string, number>()
  const r15ByEndpoint = new Map<string, RailEndpointRow[]>()
  const r16ByEndpoint = new Map<string, RailEndpointRow[]>()
  for (const r of rows) {
    if (r.railType !== 0 || r.service !== 0) continue
    const isR15Candidate = r.usage <= 1 && r.sourceId > 0
    const isR16Candidate = r.usage <= 1
    for (const [lat, lon] of [[r.startLat, r.startLon], [r.endLat, r.endLon]] as const) {
      const k = nodeKey(lat, lon)
      touchCount.set(k, (touchCount.get(k) ?? 0) + 1)
      if (isR15Candidate) {
        const arr = r15ByEndpoint.get(k)
        if (arr) arr.push(r); else r15ByEndpoint.set(k, [r])
      }
      if (isR16Candidate) {
        const arr = r16ByEndpoint.get(k)
        if (arr) arr.push(r); else r16ByEndpoint.set(k, [r])
      }
    }
  }
  const built: EndpointCandidates = { touchCount, r15ByEndpoint, r16ByEndpoint }
  endpointCandidatesMemo.set(rows, built)
  return built
}

function isExemptEndpoint(k: string, touchCount: Map<string, number>, stopsIndex: RailStopsIndex | null): boolean {
  if ((touchCount.get(k) ?? 0) >= 3) return true // junction: a 3rd heavy-rail branch explains the jump
  if (!stopsIndex) return false
  const [lat, lon] = k.split('_').map(Number)
  return stopsIndex.queryWithinRadius(lat, lon, RAIL_STOP_EXEMPT_RADIUS_M)
}

function ratioOf(a: number, b: number): number {
  return Math.max(a, b) / Math.max(1, Math.min(a, b))
}

function endpointLatLon(k: string): [number, number] {
  const [lat, lon] = k.split('_').map(Number)
  return [lat, lon]
}

/** R15 rail-flow-jump: at a degree-2 heavy-rail non-service node (usage<=1,
 *  both sides sourceId>0), EFFECTIVE traffic must not jump more than
 *  RAIL_JUMP_RATIO in pax, frt OR total. Compares ACROSS source boundaries as
 *  well as WITHIN one source (the trať 200 shape is cross-source: 110 ->
 *  9863; two adjacent rows sharing one id can band just as badly, e.g. a
 *  single feed's own chord-match miss). RAIL_MIN_EFFECTIVE_TRAINS_PER_DAY is
 *  a PER-COLUMN floor (2026-07-16 /gg review item 5): a column only competes
 *  once ITS OWN max(effA, effB) clears the floor — a busy total must never
 *  license firing on a quiet column's ratio noise (pax 2 vs 7 must not fire
 *  merely because freight happens to be busy enough on its own). One
 *  violation per endpoint. */
export function findRailFlowJumps(rows: RailEndpointRow[], stopsIndex: RailStopsIndex | null): RailContinuityViolation[] {
  const { r15ByEndpoint: byEndpoint, touchCount } = endpointCandidatesFor(rows)
  const violations: RailContinuityViolation[] = []
  for (const [k, list] of byEndpoint) {
    if (list.length !== 2) continue // degree-2 candidate nodes only
    if (isExemptEndpoint(k, touchCount, stopsIndex)) continue
    const [A, B] = list
    const effA = effectiveRailTraffic(A.pax, A.frt, A.railType, A.usage, A.parallelDivisor)
    const effB = effectiveRailTraffic(B.pax, B.frt, B.railType, B.usage, B.parallelDivisor)

    let column: 'pax' | 'frt' | 'total' | null = null
    let ratio = 0
    for (const [col, rA, rB] of [
      ['pax', effA.pax, effB.pax],
      ['frt', effA.frt, effB.frt],
      ['total', effA.total, effB.total],
    ] as const) {
      // Floor gates THIS column alone — since pax<=total and frt<=total
      // always, a column that clears the floor on its own is a superset of
      // the old (buggy) total-only gate, and a column that DOESN'T is
      // correctly ignored even when the total happens to be busy.
      if (Math.max(rA, rB) < RAIL_MIN_EFFECTIVE_TRAINS_PER_DAY) continue
      const r = ratioOf(rA, rB)
      if (r > RAIL_JUMP_RATIO && r > ratio) { column = col; ratio = r }
    }
    if (!column) continue

    const [lat, lon] = endpointLatLon(k)
    violations.push({ endpointLat: lat, endpointLon: lon, aKey: A.key, bKey: B.key, aSourceId: A.sourceId, bSourceId: B.sourceId, ratio, effA, effB, column })
  }
  return violations
}

/** R16 rail-continuity-gap: same candidate nodes, but exactly one side is
 *  measured (sourceId>0) and the other is source_id==0 — the unmeasured side
 *  resolves to the engine's PURE class defaults through `effectiveRailTraffic`
 *  (pax=frt=0 in, both columns default out). Fires on the TOTAL ratio only
 *  (there is no "measured vs measured" per-column comparison here — the gap
 *  side has no real per-column signal to compare). */
export function findRailContinuityGaps(rows: RailEndpointRow[], stopsIndex: RailStopsIndex | null): RailContinuityViolation[] {
  const { r16ByEndpoint: byEndpoint, touchCount } = endpointCandidatesFor(rows)
  const violations: RailContinuityViolation[] = []
  for (const [k, list] of byEndpoint) {
    if (list.length !== 2) continue
    const [A, B] = list
    const aMeasured = A.sourceId > 0
    const bMeasured = B.sourceId > 0
    if (aMeasured === bMeasured) continue // need exactly one measured, one gap
    if (isExemptEndpoint(k, touchCount, stopsIndex)) continue
    const measured = aMeasured ? A : B
    const gap = aMeasured ? B : A
    const effMeasured = effectiveRailTraffic(measured.pax, measured.frt, measured.railType, measured.usage, measured.parallelDivisor)
    const effGap = effectiveRailTraffic(gap.pax, gap.frt, gap.railType, gap.usage, gap.parallelDivisor)
    const ratio = ratioOf(effMeasured.total, effGap.total)
    if (ratio <= RAIL_JUMP_RATIO) continue
    const [lat, lon] = endpointLatLon(k)
    violations.push({
      endpointLat: lat, endpointLon: lon, aKey: measured.key, bKey: gap.key,
      aSourceId: measured.sourceId, bSourceId: gap.sourceId, ratio, effA: effMeasured, effB: effGap, column: 'total',
    })
  }
  return violations
}
