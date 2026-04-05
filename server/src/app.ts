import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import compress from '@fastify/compress'
import { tilesRoutes } from './routes/tiles.js'
import { searchRoutes } from './routes/search.js'
import { noiseOnflyV2Routes } from './routes/noise-onfly-v2.js'
import { isochronRoutes } from './routes/isochron.js'
import { docsRoutes } from './routes/docs.js'

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false })

  await app.register(compress)

  app.get('/api/health', async () => {
    return { status: 'ok' }
  })

  await app.register(tilesRoutes)
  await app.register(searchRoutes)
  await app.register(noiseOnflyV2Routes)
  await app.register(isochronRoutes)
  await app.register(docsRoutes)

  return app
}
