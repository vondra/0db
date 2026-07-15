/**
 * Facility→polygon match selection for the global industrial enrichers
 * (E-PRTR / GPPD / GEM in `enrich-global-industrial.ts`).
 *
 * THE rule this module owns: ONE facility stamps ONE OSM polygon — the registry
 * describes single sites, so the old everybody-within-2 km stamp (85 k facilities
 * → 607 k stamps = 7.1 polygons each; York: substations + 67 farms as "meat
 * processing", farms +20 dB) was a category error, not a coverage win.
 *
 * Selection (per /gg-reviewed plan, 2026-07-02):
 *  - candidate = polygon whose centroid is within `radiusM` of the facility point
 *    (the 2 km SEARCH horizon is an owner decision — registry coords are reporting
 *    centroids, measured median 116–234 m off the true polygon);
 *  - score = EDGE distance `centroidDist − √(area/π)` (≤0 ≈ point inside), so a
 *    50 ha plant whose centroid sits 400 m away still beats a 10 m shed 50 m away;
 *  - quiet-subtype gate: a farm/warehouse/office polygon accepts only its own
 *    industry family (farm ⇐ agriculture, warehouse ⇐ logistics) — never someone
 *    else's heavy NACE (that was the dominant mis-stamp mode);
 *  - known precision limits (accepted; real WKB point-in-polygon is the upgrade
 *    path if verification ever shows loss): long thin polygons under-credit
 *    (equivalent circle ≪ true extent) and giant blobs over-credit.
 *  - a polygon contested by several facilities goes to the shouldOverwrite order
 *    (rank → year → id, mirroring pipeline/lib/sources.ts), edge distance last.
 */

import { flatDist } from './spatial.js'

// Subtype codes from engine/osm-extract/src/spill.rs site_subtype_from_tags().
const SUBTYPE_WAREHOUSE = 1
const SUBTYPE_QUARRY = 3
const SUBTYPE_CHEMICAL = 4
const SUBTYPE_CEMENT = 5
const SUBTYPE_STEEL = 6
const SUBTYPE_FARM = 10
const SUBTYPE_OFFICE = 11

/** Heavy subtypes whose OSM tag strongly implies the sector → the polygon
 *  accepts ONLY a facility in a compatible NACE division; anything else is
 *  rejected so it can't down- or cross-classify a monolithic heavy site. This
 *  is the real Ostrava fix (/gg Codex CRITICAL 6): Nová huť is `site_subtype=6`
 *  (steel), so its 5.38 M m² polygon — the smallest edge distance for miles —
 *  must reject the on-site power block (NACE 3511) and take metallurgy (24), or
 *  fall back to the correct steel profile. NACE 2-digit divisions: quarry ⇐ coal
 *  05 / mining 08, chemical ⇐ coke-petroleum 19 / chemicals 20, cement ⇐ 23,
 *  steel ⇐ basic metals 24. Port (subtype 12) is deliberately NOT gated — real
 *  ports host chemical / food / metal tenants, so a strict gate would under-stamp. */
const HEAVY_SUBTYPE_NACE: Record<number, ReadonlySet<number>> = {
  [SUBTYPE_QUARRY]: new Set([5, 8]),
  [SUBTYPE_CHEMICAL]: new Set([19, 20]),
  [SUBTYPE_CEMENT]: new Set([23]),
  [SUBTYPE_STEEL]: new Set([24]),
}

/** What one registry row brings to the contest (precomputed once per facility). */
export interface MatchFacility {
  lat: number
  lon: number
  nace4: number // 4-digit NACE, e.g. 1011
  id: number    // dataset source_id (310 E-PRTR, 300 GPPD, 331-333 GEM)
  rank: number  // PROVENANCE_RANK of the dataset
  year: number  // dataset year (shouldOverwrite tie order)
}

/** One OSM industrial polygon as the arrow stores it. */
export interface MatchPolygon {
  lat: number
  lon: number
  areaM2: number
  subtype: number
}

/** industrial.arrow rows → MatchPolygon[] (row index preserved — winners write back by row).
 *  Shared by the global enricher and the GEM per-country driver, so the column mapping
 *  can't drift between them. `table` is an apache-arrow Table (typed loosely to keep this
 *  module dependency-free). */
export function readPolygons(table: { numRows: number; getChild: (n: string) => { get: (i: number) => unknown } | null }): MatchPolygon[] {
  const clat = table.getChild('centroid_lat')
  const clon = table.getChild('centroid_lon')
  const area = table.getChild('area_m2')
  const subtype = table.getChild('site_subtype')
  const out: MatchPolygon[] = []
  for (let i = 0; i < table.numRows; i++) {
    out.push({
      lat: (clat?.get(i) as number) ?? 0,
      lon: (clon?.get(i) as number) ?? 0,
      areaM2: (area?.get(i) as number) ?? 0,
      subtype: (subtype?.get(i) as number) ?? 0,
    })
  }
  return out
}

/**
 * Distance from the facility point to the polygon's approximate BOUNDARY:
 * centroid distance minus the equivalent-circle radius √(area/π). ≤ 0 reads
 * "inside". This is containment-lite — real WKB point-in-polygon only if
 * verification ever shows this losing true matches (/gg resolution #3).
 */
/** Equivalent-circle radius of a polygon area — the one containment-lite primitive shared by
 * edgeDistM and overlapsSameSite (a future point-in-polygon upgrade replaces exactly this). */
const equivalentCircleRadiusM = (areaM2: number): number => Math.sqrt(Math.max(areaM2, 0) / Math.PI)

export function edgeDistM(f: { lat: number; lon: number }, p: MatchPolygon): number {
  return flatDist(f.lat, f.lon, p.lat, p.lon) - equivalentCircleRadiusM(p.areaM2)
}

/**
 * Quiet-subtype gate: a specifically-quiet polygon accepts only its own industry
 * family — ALWAYS, even when the point reads as inside. The equivalent-circle
 * "inside" is unreliable on big irregular blobs (a 4 km² landuse polygon reads
 * ≤0 up to ~1.1 km from its centroid), and a registry point ON an office is the
 * classic HQ-registered-address failure, not a signal (/gg Gemini CRITICAL).
 * Families per /gg #4: farm ⇐ NACE 01-03 (a livestock E-PRTR facility SHOULD
 * stamp the farm), warehouse ⇐ 46/47/52 (wholesale/logistics), office ⇐ nothing.
 * The heavy monolithic subtypes (quarry/chemical/cement/steel) accept only
 * their own division (see HEAVY_SUBTYPE_NACE). Everything else — generic
 * industrial (0), factory (2), and port (12) — accepts any NACE.
 */
export function quietGateBlocks(subtype: number, nace4: number): boolean {
  const div = Math.floor(nace4 / 100) // NACE 2-digit division — the engine's own granularity
  if (subtype === SUBTYPE_FARM) return !(div >= 1 && div <= 3)
  if (subtype === SUBTYPE_WAREHOUSE) return !(div === 46 || div === 47 || div === 52)
  if (subtype === SUBTYPE_OFFICE) return true
  const heavy = HEAVY_SUBTYPE_NACE[subtype]
  if (heavy) return !heavy.has(div)
  return false
}

/**
 * Contest order for a polygon claimed by several facilities — mirrors
 * shouldOverwrite's rank → year → id (sources.ts), then NEARER edge distance
 * as the final, spatial tie. Returns true when `a` beats `b`.
 */
export function contestBeats(
  a: { rank: number; year: number; id: number; edge: number },
  b: { rank: number; year: number; id: number; edge: number },
): boolean {
  if (a.rank !== b.rank) return a.rank > b.rank
  if (a.year !== b.year) return a.year > b.year
  if (a.id !== b.id) return a.id > b.id
  return a.edge < b.edge
}

/**
 * Phase A for ONE facility against one hex's polygons: the best candidate
 * (smallest edge distance) whose centroid lies within `radiusM` and whose
 * subtype gate allows this NACE. Returns null when nothing qualifies here —
 * the caller reduces across hexes, so a border facility still converges to
 * ONE global winner (/gg #1).
 */
export function bestCandidate(
  fac: MatchFacility,
  polygons: MatchPolygon[],
  radiusM: number,
): { row: number; edge: number } | null {
  let best: { row: number; edge: number } | null = null
  for (let row = 0; row < polygons.length; row++) {
    const p = polygons[row]
    if (flatDist(fac.lat, fac.lon, p.lat, p.lon) >= radiusM) continue
    if (quietGateBlocks(p.subtype, fac.nace4)) continue
    const edge = edgeDistM(fac, p)
    if (!best || edge < best.edge) best = { row, edge }
  }
  return best
}

// ── I-07 dual-registry overlap dedup (Wave 2 B, dual /gg REV 2) ──────────────
// Two facilities from DIFFERENT registries can each win a DIFFERENT but coincident
// OSM polygon for ONE physical plant (Temelín: E-PRTR 123 ha + GPPD 143 ha, both
// emit → measured +2.7 dB). The per-row contest above never compares them — they
// are different rows. This reconciles ACROSS winning rows so one physical site
// emits once. MVP is COLUMNS-ONLY (centroid + area): the TS enricher can't call
// Rust `wkb.rs` (both /gg reviewers), so a real WKB-intersection test is a deferred
// upgrade. It is deliberately CONSERVATIVE — only similar-size, sizable,
// centroid-coincident polygons (the whole-site-duplicate shape) — so distinct
// adjacent plants and small nested tenants are never merged.

/** Only plants this large are de-duplicated: the double-count matters for big
 *  sites, and a high floor keeps small sheds safe. */
export const OVERLAP_MIN_AREA_M2 = 100_000 // 10 ha
/** Two footprints of the SAME site sit within this size ratio; beyond it it is a
 *  big-zone-vs-small-tenant pair (a nested case), not a whole-site duplicate. */
export const OVERLAP_AREA_RATIO_MAX = 2.5
/** Centroids must be within this fraction of the smaller polygon's equivalent
 *  radius √(area/π): coincident whole-site polygons pass; side-by-side plants
 *  (centroids ≈ √area apart) do not. */
export const OVERLAP_CENTROID_RADIUS_FACTOR = 0.5

/** One winning polygon row entering overlap reconciliation. `key` is a stable
 *  cross-hex row identifier (e.g. `${hex}:${row}`); the provenance triple + edge
 *  feed the existing `contestBeats` authority. */
export interface OverlapWinner {
  key: string
  lat: number
  lon: number
  areaM2: number
  rank: number
  year: number
  id: number
  edge: number
}

/** True when two winning polygons are the SAME physical site under the conservative
 *  whole-site-duplicate rule (sizable, similar size, centroid-coincident). */
export function overlapsSameSite(a: OverlapWinner, b: OverlapWinner): boolean {
  const amin = Math.min(a.areaM2, b.areaM2)
  if (amin < OVERLAP_MIN_AREA_M2) return false
  if (Math.max(a.areaM2, b.areaM2) / amin > OVERLAP_AREA_RATIO_MAX) return false
  const rMin = equivalentCircleRadiusM(amin)
  return flatDist(a.lat, a.lon, b.lat, b.lon) <= OVERLAP_CENTROID_RADIUS_FACTOR * rMin
}

/**
 * Keys to SUPPRESS so each physical site emits once. For every ISOLATED
 * MUTUAL-BEST overlapping pair — two winners that are each other's nearest
 * overlapping partner (no transitive 3+ merges collapsing an industrial estate,
 * /gg Codex) — the `contestBeats` LOSER is suppressed (E-PRTR rank 5 keeps its
 * row over GPPD/GEM rank 4). Internally spatially bucketed so `bestPartner` is
 * computed over each winner's true neighbourhood in ~O(n), not global O(n²), and
 * so a cross-H3R4-border pair is still seen (the caller need not pre-group).
 */
export function overlapLosers(winners: OverlapWinner[]): Set<string> {
  const CELL = 0.02 // ~2 km — wider than any merge distance (≤0.5·r; a 1000 ha plant's r≈1.8 km)
  const buckets = new Map<string, number[]>()
  const cellOf = (lat: number, lon: number): [number, number] => [Math.floor(lat / CELL), Math.floor(lon / CELL)]
  winners.forEach((w, i) => {
    const [cl, co] = cellOf(w.lat, w.lon)
    const k = `${cl}:${co}`
    const arr = buckets.get(k)
    if (arr) arr.push(i)
    else buckets.set(k, [i])
  })
  const bestPartner = new Array<number>(winners.length).fill(-1)
  for (let i = 0; i < winners.length; i++) {
    const [cl, co] = cellOf(winners[i].lat, winners[i].lon)
    let bestD = Infinity
    for (let dl = -1; dl <= 1; dl++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const j of buckets.get(`${cl + dl}:${co + dc}`) ?? []) {
          if (i === j || !overlapsSameSite(winners[i], winners[j])) continue
          const d = flatDist(winners[i].lat, winners[i].lon, winners[j].lat, winners[j].lon)
          if (d < bestD) { bestD = d; bestPartner[i] = j }
        }
      }
    }
  }
  const losers = new Set<string>()
  for (let i = 0; i < winners.length; i++) {
    const j = bestPartner[i]
    if (j < 0 || bestPartner[j] !== i || i > j) continue // mutual-best, once per pair
    const a = winners[i]
    const b = winners[j]
    const aBeatsB = contestBeats(
      { rank: a.rank, year: a.year, id: a.id, edge: a.edge },
      { rank: b.rank, year: b.year, id: b.id, edge: b.edge },
    )
    losers.add(aBeatsB ? b.key : a.key)
  }
  return losers
}
