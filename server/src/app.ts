import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import compress from '@fastify/compress'
import { searchRoutes } from './routes/search.js'
import { noiseOnflyV2Routes } from './routes/noise-onfly-v2.js'
import { isochronRoutes } from './routes/isochron.js'
import { docsRoutes } from './routes/docs.js'
import { propertiesRoutes } from './routes/properties.js'
import { rasterTileRoutes } from './routes/raster-tiles.js'
import { aircraftRoutes } from './routes/aircraft.js'
import { heatmapV3Routes } from './routes/heatmap-v3.js'
import { heatmapPmtilesRoutes } from './routes/heatmap-pmtiles.js'
import { tilesManifestRoutes } from './routes/tiles-manifest.js'
import { clusterRoutes } from './routes/cluster.js'

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false })

  await app.register(compress)

  app.get('/api/health', async () => {
    return { status: 'ok' }
  })

  await app.register(searchRoutes)
  await app.register(noiseOnflyV2Routes)
  await app.register(isochronRoutes)
  await app.register(docsRoutes)
  await app.register(propertiesRoutes)
  await app.register(rasterTileRoutes)
  await app.register(aircraftRoutes)
  await app.register(heatmapV3Routes)
  // Dual-read during the pmtiles migration: the versioned archive route +
  // manifest serve alongside the loose-file route above.
  await app.register(heatmapPmtilesRoutes)
  await app.register(tilesManifestRoutes)
  await app.register(clusterRoutes)

  return app
}
