/**
 * On-the-fly noise computation v2 — unified Rust engine.
 */

import type { FastifyInstance } from 'fastify'
import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import {
  NoiseOnflyRequestError,
  NoiseOnflySupervisor,
} from '../engine/noise-onfly-supervisor.js'

// Wire shape is built entirely in Rust (engine/source-reader/src/wire.rs).
// Node forwards the JSON string after one sentinel replace for
// `compute_time_ms`. Previously this route parsed, reshaped, and
// re-stringified — the cause of `provenance: null` and
// `total_lden_free: null` regressions (Rust struct renames silently
// diverged from Node's reshape). Single source of truth, ~30-50 ms saved.

import { DATA_YEAR as YEAR } from '../data-year.js'

const SOURCE_READER_PATH = resolve(import.meta.dirname, '../../../engine/source-reader/target/release/libsource_reader.so')
const H3R4_DIR = process.env.H3R4_DIR || resolve(import.meta.dirname, `../../../data/prepared/${YEAR}/h3r4`)
const WORKER_URL = new URL('../workers/noise-onfly-worker.mjs', import.meta.url)
const NOISE_ONFLY_WORK_TIMEOUT_MS = Number(process.env.NOISE_ONFLY_WORK_TIMEOUT_MS || '30000')
const NOISE_ONFLY_QUEUE_TIMEOUT_MS = Number(process.env.NOISE_ONFLY_QUEUE_TIMEOUT_MS || '10000')
const NOISE_ONFLY_MAX_QUEUE = Number(process.env.NOISE_ONFLY_MAX_QUEUE || '8')
// Pool of NAPI workers — each holds its own ~150 MB Rust state (R-trees
// per loaded R4) so memory scales linearly. Mmap'd Arrow + DEM rasters are
// shared via OS page cache. Default 4 covers typical concurrent-user
// clicks on the map without queueing.
const NOISE_ONFLY_POOL_SIZE = Number(process.env.NOISE_ONFLY_POOL_SIZE || '4')

export async function noiseOnflyV2Routes(app: FastifyInstance): Promise<void> {
  const supervisor = new NoiseOnflySupervisor({
    createWorker: () =>
      new Worker(WORKER_URL, {
        workerData: {
          sourceReaderPath: SOURCE_READER_PATH,
          h3r4Dir: H3R4_DIR,
        },
      }),
    maxQueue: NOISE_ONFLY_MAX_QUEUE,
    queueTimeoutMs: NOISE_ONFLY_QUEUE_TIMEOUT_MS,
    workTimeoutMs: NOISE_ONFLY_WORK_TIMEOUT_MS,
    poolSize: NOISE_ONFLY_POOL_SIZE,
    logger: (level, message, meta) => {
      if (meta) {
        app.log[level](meta, message)
        return
      }
      app.log[level](message)
    },
  })

  app.addHook('onClose', async () => {
    await supervisor.close()
  })

  app.get<{ Querystring: { lat?: string; lng?: string; full?: string } }>(
    '/api/noise-onfly-v2',
    async (request, reply) => {
      const lat = parseFloat(request.query.lat ?? '')
      const lng = parseFloat(request.query.lng ?? '')
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return reply.status(400).send({ error: 'valid lat and lng required' })
      }
      const full = request.query.full === '1' || request.query.full === 'true'

      const t0 = Date.now()
      const abortController = new AbortController()
      const onClose = () => {
        abortController.abort()
      }
      request.raw.once('close', onClose)

      try {
        const resultJson = full
          ? await supervisor.queryNoiseAtPointUnfiltered(lat, lng, abortController.signal)
          : await supervisor.queryNoiseAtPoint(lat, lng, abortController.signal)
        const elapsed = Date.now() - t0

        // Rust builds the final wire shape directly (engine/source-reader/
        // src/wire.rs). Node injects only the wall-time measurement via a
        // single sentinel replace, then sends the string as-is — Fastify
        // forwards strings with explicit `application/json` content-type
        // without re-serializing (saves ~30-50 ms per popup vs the prior
        // parse + reshape + auto-stringify path).
        const sentinel = '"compute_time_ms":"__QM_COMPUTE_TIME_MS__"'
        const replaced = `"compute_time_ms":${elapsed}`
        const finalJson = resultJson.replace(sentinel, replaced)
        if (finalJson === resultJson) {
          throw new Error(`compute_time_ms sentinel missing from Rust output`)
        }
        if (finalJson.includes('__QM_COMPUTE_TIME_MS__')) {
          throw new Error(`compute_time_ms sentinel appeared more than once`)
        }
        return reply.type('application/json').send(finalJson)
      } catch (err) {
        if (abortController.signal.aborted || request.raw.aborted || request.raw.destroyed) {
          return
        }
        const error = err instanceof Error ? err : new Error(String(err))
        const message = error.message
        const statusCode = err instanceof NoiseOnflyRequestError
          ? err.statusCode
          : message.includes('timeout')
            ? 504
            : 500
        return reply.status(statusCode).send({ error: message })
      } finally {
        request.raw.removeListener('close', onClose)
      }
    }
  )
}
