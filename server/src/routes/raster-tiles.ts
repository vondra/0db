import type { FastifyInstance } from 'fastify'
import { renderTile, getEmptyPng, preloadBarriers } from '../engine/raster-tile-renderer.js'

const VALID_LAYERS = new Set(['dem', 'building', 'forest', 'barriers'])
const MIN_ZOOM = 6
const MAX_ZOOM = 16
const CACHE_MAX = 500

const pngCache = new Map<string, Buffer>()
const pngLru: string[] = []

export async function rasterTileRoutes(app: FastifyInstance): Promise<void> {
  // Preload barrier segments async — doesn't block server startup or event loop
  preloadBarriers().catch(() => {})
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
      if (pngCache.has(cacheKey)) {
        const idx = pngLru.indexOf(cacheKey)
        if (idx !== -1) { pngLru.splice(idx, 1); pngLru.push(cacheKey) }
        reply.header('Content-Type', 'image/png')
        reply.header('Cache-Control', 'public, max-age=86400')
        return pngCache.get(cacheKey)
      }

      let png: Buffer
      try {
        png = await renderTile(layer as 'dem' | 'building' | 'forest', z, x, y)
      } catch {
        png = getEmptyPng()
      }

      if (pngLru.length >= CACHE_MAX) {
        const evict = pngLru.shift()!
        pngCache.delete(evict)
      }
      pngCache.set(cacheKey, png)
      pngLru.push(cacheKey)

      reply.header('Content-Type', 'image/png')
      reply.header('Cache-Control', 'public, max-age=86400')
      return png
    },
  )
}
