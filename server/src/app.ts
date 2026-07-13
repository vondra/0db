import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import compress from '@fastify/compress'
import { randomUUID } from 'node:crypto'
import { searchRoutes } from './routes/search.js'
import { noiseOnflyV2Routes } from './routes/noise-onfly-v2.js'
import { isochronRoutes } from './routes/isochron.js'
import { docsRoutes } from './routes/docs.js'
import { propertiesRoutes } from './routes/properties.js'
import { rasterTileRoutes } from './routes/raster-tiles.js'
import { aircraftRoutes } from './routes/aircraft.js'
import { heatmapPmtilesRoutes } from './routes/heatmap-pmtiles.js'
import { tilesManifestRoutes } from './routes/tiles-manifest.js'
import { validationViewRoutes } from './routes/validation-view.js'
import { healthRoutes } from './routes/health.js'
import { createReadinessCheck, type ReadinessCheck } from './runtime-readiness.js'
import { requireLoopback } from './internal-access.js'

// Deliberately identifies only this Node process, not its build or data. Long
// validation runs use it to reject results spanning a restart/deploy.
const INSTANCE_ID = randomUUID()

export type BuildAppOptions = {
  logger?: boolean
  readinessCheck?: ReadinessCheck
  enableClusterRoutes?: boolean
  noIndex?: boolean
  preloadRuntimeData?: boolean
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Never trust arbitrary forwarding headers. Caddy reaches Fastify from
    // loopback; only that hop may supply the public client's address.
    trustProxy: ['127.0.0.1', '::1'],
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-0db-Instance', INSTANCE_ID)
    return payload
  })

  if (opts.noIndex ?? process.env.ROBOTS_NOINDEX === '1') {
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
      return payload
    })
  }

  await app.register(compress)

  await app.register(searchRoutes)
  // Registered directly because the readiness probe is a capability returned
  // by the live supervisor instance; Fastify plugin registration discards a
  // plugin's return value.
  const engineProbe = await noiseOnflyV2Routes(app)
  await app.register(isochronRoutes)
  await app.register(docsRoutes)
  await app.register(propertiesRoutes)
  await app.register(rasterTileRoutes, { preloadRuntimeData: opts.preloadRuntimeData ?? false })
  await app.register(aircraftRoutes)
  // Heatmap tiles: immutable pmtiles builds addressed by build-id, discovered
  // via the manifest (storage redesign 2026-07). The loose-file route is gone
  // with the loose trees.
  await app.register(heatmapPmtilesRoutes)
  await app.register(tilesManifestRoutes)
  await app.register(validationViewRoutes)

  const readiness = opts.readinessCheck ?? createReadinessCheck({ engineProbe })
  await healthRoutes(app, readiness)

  const enableClusterRoutes = opts.enableClusterRoutes
    ?? process.env.ENABLE_CLUSTER_ROUTES === '1'
  if (enableClusterRoutes) {
    // Dynamic import means a public-only process never even loads code that
    // reads SSH inventory, worker logs, costs, or cluster telemetry.
    const { clusterRoutes } = await import('./routes/cluster.js')
    await app.register(async (internalApp) => {
      internalApp.addHook('onRequest', requireLoopback)
      await internalApp.register(clusterRoutes)
    })
  }

  return app
}
