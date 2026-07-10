/**
 * Shared spatial helpers used by enrichment pipelines and bench tools.
 *
 * Most enrichers historically declared their own copies of `flatDist`,
 * `pointToSegmentDist`, `inBbox`, etc. — same formula, slight signature
 * drift across files (e.g. `pointInRing(lon, lat, ring)` vs
 * `pointInRing(lat, lon, ring)`). This module is the canonical source.
 *
 * Conventions:
 *   - Distances in metres.
 *   - Lat/lon order: lat first, EXCEPT for `pointInRing` which keeps the
 *     GeoJSON-native (lon, lat) order for parity with `scripts/build-h3-admin.ts`.
 *   - Bounding boxes: `[minLat, minLon, maxLat, maxLon]`.
 *   - Distance helpers use the flat-earth approximation (cosLat at the
 *     midpoint) — matches `engine/noise-compute/src/propagation/geo.rs::flat_dist`,
 *     accurate to <0.3 % at <50 km. Use `haversineM` if you specifically
 *     need spheroidal accuracy beyond that range.
 */

const M_PER_DEG_LAT = 110_540
const M_PER_DEG_LON_EQ = 111_320

/**
 * Endpoint identity for road-segment topology: quantize to ~1 m so segments
 * that share a physical node compare equal. THE shared scheme for every pass
 * that chains segments by endpoints (service-tree, continuity-fill, R7 taper)
 * — the passes must agree on node identity or their topologies silently
 * diverge.
 */
export function nodeKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)}_${lon.toFixed(5)}`
}

/**
 * Flat-earth distance in metres between two (lat, lon) points. Same
 * algorithm as the engine's `flat_dist` — accurate to <0.3 % at <50 km.
 * Hot-loop callers that have a hex-level cosLat should pre-project to
 * x/y instead of paying a `Math.cos` per call (see
 * `pipeline/enrich-roads-service-tree.ts::pointToSegmentDistXY`).
 */
export function flatDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const cosLat = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180)
  const dx = (lon2 - lon1) * M_PER_DEG_LON_EQ * cosLat
  const dy = (lat2 - lat1) * M_PER_DEG_LAT
  return Math.sqrt(dx * dx + dy * dy)
}

/** Alias so callers that grew up calling it `flatDistM` keep working
 *  without a local copy. */
export const flatDistM = flatDist

/**
 * Spheroidal great-circle distance in metres. ~10× more expensive than
 * `flatDist`; only worth it for distances >50 km where flat-earth drifts
 * past 0.3 %. The 19 enrichers that previously declared `haversineM`
 * locally were all using it for sub-1-km buffer checks where flat-earth
 * is fine — they can switch to `flatDist` if they want the speed.
 */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_008.8
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/**
 * Distance from point `p` to segment `a → b`, all in (lat, lon) degrees.
 * Single-shot helper — for hot loops that compute many distances against
 * the same segment, pre-project once and use a pure-arithmetic kernel
 * (see service-tree's `pointToSegmentDistXY`).
 */
export function pointToSegmentDist(
  pLat: number, pLon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): number {
  const cosLat = Math.cos(pLat * Math.PI / 180)
  const px = pLon * M_PER_DEG_LON_EQ * cosLat
  const py = pLat * M_PER_DEG_LAT
  const ax = aLon * M_PER_DEG_LON_EQ * cosLat
  const ay = aLat * M_PER_DEG_LAT
  const bx = bLon * M_PER_DEG_LON_EQ * cosLat
  const by = bLat * M_PER_DEG_LAT
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return flatDist(pLat, pLon, aLat, aLon)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy))
}

/**
 * Min distance (m) from point `(pLat, pLon)` to a polyline given as
 * `[lon, lat]` vertices (GeoJSON-native order). Returns `Infinity` for an
 * empty line, the point-to-vertex distance for a single vertex.
 *
 * Matching a road segment to the nearest point ON a census section's line —
 * instead of to the section's centroid — places the boundary between two
 * adjacent sections at the real junction rather than on the perpendicular
 * bisector of their centroids (which drifts hundreds of metres when the
 * sections differ in length). 14 country enrichers carried a private copy of
 * this; this is the canonical one.
 */
export function pointToPolylineDist(
  pLat: number,
  pLon: number,
  coords: ReadonlyArray<readonly [number, number]>,
): number {
  if (coords.length === 0) return Infinity
  if (coords.length === 1) return flatDist(pLat, pLon, coords[0][1], coords[0][0])
  let best = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const d = pointToSegmentDist(pLat, pLon, coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0])
    if (d < best) best = d
  }
  return best
}

/**
 * Inclusive bounding-box test. `bbox = [minLat, minLon, maxLat, maxLon]`.
 * Most enrichers used this exact convention with a 4-tuple; a handful
 * passed a wider `number[]` — the wider type is implicit-compatible.
 */
export function inBbox(
  lat: number,
  lon: number,
  bbox: readonly [number, number, number, number],
): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}

/**
 * Ray-cast point-in-polygon test. **Lon-first arg order**, matching
 * GeoJSON's native (lon, lat) ring ordering and the
 * `scripts/build-h3-admin.ts` convention. The 3-or-so enrichers that
 * declared a `pointInRing(lat, lon, ring)` variant had their args
 * swapped relative to GeoJSON; migrate carefully if porting them over.
 */
export function pointInRing(lon: number, lat: number, ring: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
      inside = !inside
    }
  }
  return inside
}
