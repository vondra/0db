import type { FastifyInstance } from 'fastify'
import { renderTile, getEmptyPng, preloadBarriers } from '../engine/raster-tile-renderer.js'

const VALID_LAYERS = new Set(['dem', 'building', 'forest', 'barriers'])
const MIN_ZOOM = 6
const MAX_ZOOM = 16
const CACHE_MAX = 500

// Map preserves insertion order; delete+re-set promotes to end = O(1) LRU
const pngCache = new Map<string, Buffer>()

export async function rasterTileRoutes(app: FastifyInstance): Promise<void> {
  // Preload barrier segments async — doesn't block server startup or event loop
  preloadBarriers().catch(err => console.error('barrier preload failed:', err))
  app.get<{ Params: { layer: string; z: string; x: string; y: string } }>(
    '/api/raster/:layer/:z/:x/:y.png',
    async (request, reply) => {
      const { layer, z: zStr, x: xStr } = request.params
      const yStr = request.params.y

      if (!VALID_LAYERS.has(layer)) {
        return reply.code(400).send('Invalid layer')
      }

      const z = Number(zStr)
      const x = Number(xStr)
      const y = Number(yStr)

      if (!Number.isInteger(z) || z < MIN_ZOOM || z > MAX_ZOOM) {
        return reply.code(400).send('Invalid zoom')
      }
      const max = 2 ** z
      if (!Number.isInteger(x) || x < 0 || x >= max || !Number.isInteger(y) || y < 0 || y >= max) {
        return reply.code(400).send('Invalid coordinates')
      }

      const cacheKey = `${layer}/${z}/${x}/${y}`
      const cached = pngCache.get(cacheKey)
      if (cached !== undefined) {
        // Promote to newest: delete + re-set = O(1) LRU via Map insertion order
        pngCache.delete(cacheKey)
        pngCache.set(cacheKey, cached)
        reply.header('Content-Type', 'image/png')
        reply.header('Cache-Control', 'public, max-age=86400')
        return cached
      }

      let png: Buffer
      try {
        png = await renderTile(layer as 'dem' | 'building' | 'forest', z, x, y)
      } catch {
        png = getEmptyPng()
      }

      pngCache.set(cacheKey, png)
      if (pngCache.size > CACHE_MAX) {
        // Evict oldest (first key in insertion order)
        const oldest = pngCache.keys().next().value!
        pngCache.delete(oldest)
      }

      reply.header('Content-Type', 'image/png')
      reply.header('Cache-Control', 'public, max-age=86400')
      return png
    },
  )
}
