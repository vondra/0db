/**
 * Building-raster sampler for the road `built_up` flag (task #15).
 *
 * Reads the shared 1°×1° building-height tiles
 * (`data/prepared/rasters/building/N53W002.raw`, u8 metres, 0 = no building)
 * and counts built pixels in a square window around a point. The ONE consumer
 * that writes the flag is `enrich-roads-built-up.ts`; the engine reads the
 * resulting `built_up` column in `noise-compute::defaults::resolve_speed_default`.
 *
 * Tile layout — VERIFIED EMPIRICALLY 2026-07-03 (and identical to
 * engine/raster-reader/src/tile.rs): file named by its SOUTH-WEST corner
 * (floor(lat)/floor(lon)), square u8 grid (3601×3601 for current tiles, side
 * derived from file size like RawTile::load), row 0 = NORTH edge, so
 * row = round((1 − fracLat)·(side−1)), col = round(fracLon·(side−1)).
 * Check used: Wetherby town centre (53.928,−1.387) → 80/289 built px with this
 * orientation vs 18/289 flipped; Dobříš (49.78,14.17) → 63/289 vs 0/289
 * flipped; open fields (53.96,−1.34) → 0/289.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export const BUILT_UP_UNKNOWN = 0 // covering raster tile missing — engine falls back to the legacy speed table
export const BUILT_UP_RURAL = 1
export const BUILT_UP_URBAN = 2

/** Calibrated 2026-07-03 on cells 841942dffffffff (GB/Wetherby) +
 *  841e309ffffffff (CZ/Dobříš): ground truth = tagged maxspeed on classes
 *  2/3/4/9, ≤50 km/h ⇒ urban. Grid search radius {2,3,5,8} px × min-built
 *  {1,2,3,5,8}: winner r=8 (240 m), min=8 at 79.0 % pooled agreement
 *  (GB 84.9 %, CZ 63.8 % — CZ dragged only by Brdy forest roads bulk-tagged
 *  maxspeed=50; on classes 2/3/4 the same winner scores 85.0 % pooled,
 *  GB 84.2 % / CZ 87.4 %). Full matrix in enrich-roads-built-up.ts header. */
export const BUILT_UP_WINDOW_RADIUS_PX = 8
export const BUILT_UP_MIN_BUILT_PIXELS = 8

/** The shared (year-independent) building-height tile set. Exported so the
 *  enricher can fail loud when the whole set is absent (≠ one missing tile). */
export const BUILDING_RASTER_DIR = resolve(import.meta.dirname, '../../data/prepared/rasters/building')

interface LoadedTile {
  data: Buffer
  side: number // pixels per side (3601 for current 30 m tiles)
}

/**
 * Whole-tile reader with a small LRU cache (a 3601² tile is ~13 MB; road
 * midpoints inside one H3R4 hex touch at most 4 tiles, so the default cache
 * of 12 covers a hex plus sorted-order neighbours). Missing tiles are cached
 * as null so a hex over ocean doesn't re-stat the path per segment.
 */
export class BuildingRasterSampler {
  private cache = new Map<string, LoadedTile | null>()

  constructor(
    private tileDir: string = BUILDING_RASTER_DIR,
    private maxCachedTiles = 12,
  ) {}

  /** SW-corner tile name, e.g. (53.9,−1.4) → "N53W002" — same scheme as raster-reader. */
  static tileNameFor(lat: number, lon: number): string {
    const la = Math.floor(lat)
    const lo = Math.floor(lon)
    const ns = la >= 0 ? 'N' : 'S'
    const ew = lo >= 0 ? 'E' : 'W'
    return `${ns}${String(Math.abs(la)).padStart(2, '0')}${ew}${String(Math.abs(lo)).padStart(3, '0')}`
  }

  private getTile(lat: number, lon: number): LoadedTile | null {
    const name = BuildingRasterSampler.tileNameFor(lat, lon)
    const hit = this.cache.get(name)
    if (hit !== undefined) {
      this.cache.delete(name) // re-insert → most-recently-used
      this.cache.set(name, hit)
      return hit
    }
    let loaded: LoadedTile | null = null
    const path = resolve(this.tileDir, `${name}.raw`)
    try {
      const size = statSync(path).size
      const side = Math.round(Math.sqrt(size))
      // A present-but-broken tile must FAIL, not classify a country as unknown:
      // built_up=0 is contractually "covering tile ABSENT" only (/gg Codex).
      if (side * side !== size || side <= 1) throw new Error(`non-square building tile ${path} (${size} B)`)
      loaded = { data: readFileSync(path), side }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      /* ENOENT → stays null = missing tile */
    }
    this.cache.set(name, loaded)
    if (this.cache.size > this.maxCachedTiles) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return loaded
  }

  /**
   * Count of built pixels (height > 0) in the (2·radiusPx+1)² window centred
   * on the nearest pixel to (lat, lon), or null when the covering tile is
   * missing. The window CLAMPS to the covering tile (no neighbour-tile reads):
   * only points within radiusPx of a 1° edge lose part of the window
   * (≤ 2·r/3600 ≈ 0.2 % of segments at r=3), matching the engine sampler's
   * per-tile clamp in raster-reader tile.rs.
   */
  builtPixelCount(lat: number, lon: number, radiusPx: number): number | null {
    const tile = this.getTile(lat, lon)
    if (!tile) return null
    const max = tile.side - 1
    const row = Math.round((1 - (lat - Math.floor(lat))) * max)
    const col = Math.round((lon - Math.floor(lon)) * max)
    const r0 = Math.max(0, row - radiusPx)
    const r1 = Math.min(max, row + radiusPx)
    const c0 = Math.max(0, col - radiusPx)
    const c1 = Math.min(max, col + radiusPx)
    let built = 0
    for (let rr = r0; rr <= r1; rr++) {
      const base = rr * tile.side
      for (let cc = c0; cc <= c1; cc++) if (tile.data[base + cc] > 0) built++
    }
    return built
  }

  /** The calibrated urban/rural decision for one point (a road-segment midpoint). */
  classifyBuiltUp(lat: number, lon: number): number {
    const built = this.builtPixelCount(lat, lon, BUILT_UP_WINDOW_RADIUS_PX)
    if (built === null) return BUILT_UP_UNKNOWN
    return built >= BUILT_UP_MIN_BUILT_PIXELS ? BUILT_UP_URBAN : BUILT_UP_RURAL
  }
}
