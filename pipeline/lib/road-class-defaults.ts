/**
 * Per-class default AADT — TS mirror of the engine's `WORLD_DEFAULT` table
 * (`engine/noise-compute/src/defaults.rs`). The engine applies a city → country →
 * continent → world cascade; this is ONLY the world tier, which is all the
 * continuity-fill needs to ESTIMATE an unmeasured branch's flow (or weight a
 * ratio split). Keep in sync with defaults.rs if those values change.
 *
 * Tuple = (light, medium, heavy, moto) veh/day, both directions.
 * Index = engine road_class: 0 motorway … 4 tertiary … 9 unclassified, 10-12 links.
 */
export type Aadt = readonly [light: number, medium: number, heavy: number, moto: number]

export const WORLD_DEFAULT: readonly Aadt[] = [
  [21600, 2400, 5700, 300], // 0 motorway — 30k
  [11700, 1200, 1800, 300], // 1 trunk — 15k
  [7470, 540, 810, 180], // 2 primary — 9k
  [2640, 120, 180, 60], // 3 secondary — 3k
  [720, 26, 38, 16], // 4 tertiary — 800
  [480, 5, 10, 5], // 5 residential — 500
  [98, 0, 1, 1], // 6 living_street — 100
  [240, 2, 5, 3], // 7 service — 250
  [4, 0, 1, 0], // 8 track — 5
  [1200, 30, 80, 30], // 9 unclassified — 1340
  [3240, 360, 855, 45], // 10 motorway_link — 4500
  [1755, 180, 270, 45], // 11 trunk_link — 2250
  [1120.5, 81, 121.5, 27], // 12 primary_link — 1350
]

/** Default AADT tuple for a road_class (clamps out-of-range to the last entry,
 *  same as the engine's `resolve_traffic_default` fallback). */
export function classDefault(roadClass: number): Aadt {
  return WORLD_DEFAULT[Math.min(Math.max(roadClass, 0), WORLD_DEFAULT.length - 1)]
}

/** Total default veh/day for a road_class (sum of the four vehicle classes). */
export function classDefaultTotal(roadClass: number): number {
  const [l, m, h, mo] = classDefault(roadClass)
  return l + m + h + mo
}
