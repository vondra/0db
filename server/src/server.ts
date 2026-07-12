import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { registerWeb } from './web.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = await buildApp({
  logger: true,
  // Tests and compiled smoke opt out so the deterministic gate never scans
  // the mutable prepared-data tree. Production keeps the existing warmup.
  preloadRuntimeData: process.env.PRELOAD_RUNTIME_DATA !== '0',
})

const bundledFrontend = path.join(__dirname, 'frontend')
const frontendDist = process.env.FRONTEND_DIST
  ? path.resolve(process.env.FRONTEND_DIST)
  : existsSync(path.join(bundledFrontend, 'index.html'))
    ? bundledFrontend
    : path.join(__dirname, '..', '..', 'frontend', 'dist')
await registerWeb(app, frontendDist)

const portText = process.env.PORT ?? '8501'
if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  throw new Error(`invalid PORT ${JSON.stringify(portText)} (expected 1-65535)`)
}
const port = Number(portText)
const host = process.env.HOST || '0.0.0.0'

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'server shutting down')
    try {
      await app.close()
      process.exit(0)
    } catch (error) {
      app.log.error(error)
      process.exit(1)
    }
  })
}

try {
  await app.listen({ port, host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
