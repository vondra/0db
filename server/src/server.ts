import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import { buildApp } from './app.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = await buildApp({ logger: true })

// Serve frontend production build. preCompressed: the build writes sibling
// .br files (frontend/scripts/precompress.mjs, brotli max quality) — served
// verbatim to br-capable clients, beating on-the-fly q4-ish compression at
// zero per-request CPU.
const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist')
app.register(fastifyStatic, { root: frontendDist, preCompressed: true })

// SPA fallback: non-API routes serve index.html
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/')) {
    return reply.status(404).send({ error: 'Not found' })
  }
  return reply.sendFile('index.html')
})

const port = Number(process.env.PORT) || 8501
const host = process.env.HOST || '0.0.0.0'

app.listen({ port, host }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
