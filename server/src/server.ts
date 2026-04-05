import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import { buildApp } from './app.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = await buildApp({ logger: true })

// Serve frontend production build
const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist')
app.register(fastifyStatic, { root: frontendDist })

// SPA fallback: non-API routes serve index.html
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/')) {
    return reply.status(404).send({ error: 'Not found' })
  }
  return reply.sendFile('index.html')
})

const port = Number(process.env.PORT) || 8501

app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
