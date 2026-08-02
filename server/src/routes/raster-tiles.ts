import type { FastifyInstance } from 'fastify'
import { renderTile, renderDataTile, renderBuildingVectorTile, getEmptyPng, preloadBarriers } from '../engine/raster-tile-renderer.js'

const VALID_LAYERS = new Set(['dem', 'building', 'forest', 'barriers'])
const VALID_DATA_LAYERS = new Set(['dem', 'building', 'forest'])
const MIN_ZOOM = 6
const MAX_ZOOM = 16
const CACHE_MAX = 500

// Map insertion order = LRU order; `delete + set` promotes to newest in O(1).
const pngCache = new Map<string, Buffer>()
const dataCache = new Map<string, Buffer>()

function lruGet(cache: Map<string, Buffer>, key: string): Buffer | undefined {
  const v = cache.get(key)
  if (v === undefined) return undefined
  cache.delete(key)
  cache.set(key, v)
  return v
}

function lruSet(cache: Map<string, Buffer>, key: string, value: Buffer): void {
  cache.set(key, value)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function parseTileParams(
  params: { layer: string; z: string; x: string; y: string },
  validLayers: Set<string>,
): { layer: string; z: number; x: number; y: number } | string {
  const { layer, z: zStr, x: xStr, y: yStr } = params
  if (!validLayers.has(layer)) return 'Invalid layer'
  const z = Number(zStr); const x = Number(xStr); const y = Number(yStr)
  if (!Number.isInteger(z) || z < MIN_ZOOM || z > MAX_ZOOM) return 'Invalid zoom'
  const max = 2 ** z
  if (!Number.isInteger(x) || x < 0 || x >= max || !Number.isInteger(y) || y < 0 || y >= max) {
    return 'Invalid coordinates'
  }
  return { layer, z, x, y }
}

export type RasterTileRouteOptions = {
  preloadRuntimeData?: boolean
  /** Popup-engine footprint provider — when present, the `building` layer
   *  renders MODEL-TRUTH vector footprints (as-used heights incl. the
   *  low-profile cap) instead of the legacy 30 m raster. */
  queryObstacleFootprints?: (south: number, west: number, north: number, east: number) => Promise<string>
}

export async function rasterTileRoutes(
  app: FastifyInstance,
  options: RasterTileRouteOptions = {},
): Promise<void> {
  if (options.preloadRuntimeData) {
    preloadBarriers().catch(err => app.log.error(err, 'barrier preload failed'))
  }

  app.get<{ Params: { layer: string; z: string; x: string; y: string } }>(
    '/api/raster/:layer/:z/:x/:y.png',
    async (request, reply) => {
      const parsed = parseTileParams(request.params, VALID_LAYERS)
      if (typeof parsed === 'string') return reply.code(400).send(parsed)
      const { layer, z, x, y } = parsed

      const vectorBuildings = layer === 'building' && options.queryObstacleFootprints
      const cacheKey = `${vectorBuildings ? 'building-vec' : layer}/${z}/${x}/${y}`
      reply.header('Content-Type', 'image/png')
      // Model-truth footprints change with the obstacle store + cap logic —
      // cache them shorter than the static rasters.
      reply.header('Cache-Control', vectorBuildings ? 'public, max-age=3600' : 'public, max-age=86400')

      const cached = lruGet(pngCache, cacheKey)
      if (cached !== undefined) return cached

      let png: Buffer
      try {
        png = vectorBuildings
          ? await renderBuildingVectorTile(z, x, y, options.queryObstacleFootprints!)
          : await renderTile(layer as 'dem' | 'building' | 'forest', z, x, y)
      } catch {
        png = getEmptyPng()
      }
      lruSet(pngCache, cacheKey, png)
      return png
    },
  )

  // Raw cell-value tiles for the hover cell inspector. Same z/x/y grid as
  // the PNG endpoint; payload is Int16 (DEM) / u8 (building, forest) so the
  // client can look up per-cell values locally without per-hover round-trips.
  app.get<{ Params: { layer: string; z: string; x: string; y: string } }>(
    '/api/raster-data/:layer/:z/:x/:y.bin',
    async (request, reply) => {
      const parsed = parseTileParams(request.params, VALID_DATA_LAYERS)
      if (typeof parsed === 'string') return reply.code(400).send(parsed)
      const { layer, z, x, y } = parsed

      const cacheKey = `${layer}/${z}/${x}/${y}`
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Cache-Control', 'public, max-age=86400')

      const cached = lruGet(dataCache, cacheKey)
      if (cached !== undefined) return cached

      const data = await renderDataTile(layer as 'dem' | 'building' | 'forest', z, x, y)
      lruSet(dataCache, cacheKey, data)
      return data
    },
  )
}
