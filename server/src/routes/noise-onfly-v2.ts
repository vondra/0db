/**
 * On-the-fly noise computation v2 — unified Rust engine.
 */

import type { FastifyInstance } from 'fastify'
import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { getElevation } from '../engine/dem-reader.js'

const SOURCE_READER_PATH = resolve(import.meta.dirname, '../../../engine/source-reader/target/release/libsource_reader.so')
const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = process.env.H3R4_DIR || resolve(import.meta.dirname, `../../../data/prepared/${YEAR}/h3r4`)
const WORKER_URL = new URL('../workers/noise-onfly-worker.mjs', import.meta.url)
const NOISE_ONFLY_TIMEOUT_MS = Number(process.env.NOISE_ONFLY_TIMEOUT_MS || '8000')

type WorkerReply = {
  id: number
  ok: boolean
  resultJson?: string
  error?: string
}

type PendingQuery = {
  resolve: (resultJson: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

let worker: Worker | null = null
let nextRequestId = 1
const pendingQueries = new Map<number, PendingQuery>()

function rejectAllPending(err: Error): void {
  for (const { reject, timer } of pendingQueries.values()) {
    clearTimeout(timer)
    reject(err)
  }
  pendingQueries.clear()
}

async function disposeWorker(): Promise<void> {
  const current = worker
  worker = null
  if (!current) {
    return
  }
  try {
    await current.terminate()
  } catch {
    // ignore terminate failures during worker recycling
  }
}

function ensureWorker(): Worker {
  if (worker) {
    return worker
  }

  const current = new Worker(WORKER_URL, {
    workerData: {
      sourceReaderPath: SOURCE_READER_PATH,
      h3r4Dir: H3R4_DIR,
    },
  })

  current.on('message', (message: WorkerReply) => {
    const pending = pendingQueries.get(message.id)
    if (!pending) {
      return
    }
    pendingQueries.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok && message.resultJson !== undefined) {
      pending.resolve(message.resultJson)
    } else {
      pending.reject(new Error(message.error || 'noise-onfly worker failed'))
    }
  })

  current.on('error', (err) => {
    if (worker === current) {
      worker = null
    }
    rejectAllPending(err instanceof Error ? err : new Error(String(err)))
  })

  current.on('exit', (code) => {
    if (worker === current) {
      worker = null
    }
    if (code !== 0) {
      rejectAllPending(new Error(`noise-onfly worker exited with code ${code}`))
    }
  })

  worker = current
  return current
}

async function queryNoiseAtPoint(lat: number, lng: number): Promise<string> {
  const current = ensureWorker()
  const id = nextRequestId++

  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingQueries.delete(id)
      void disposeWorker()
      reject(new Error(`noise-onfly timeout after ${NOISE_ONFLY_TIMEOUT_MS} ms`))
    }, NOISE_ONFLY_TIMEOUT_MS)

    pendingQueries.set(id, { resolve, reject, timer })
    current.postMessage({ id, lat, lng })
  })
}

export async function noiseOnflyV2Routes(app: FastifyInstance): Promise<void> {
  app.addHook('onClose', async () => {
    await disposeWorker()
  })

  app.get<{ Querystring: { lat?: string; lng?: string } }>(
    '/api/noise-onfly-v2',
    async (request, reply) => {
      const lat = parseFloat(request.query.lat ?? '')
      const lng = parseFloat(request.query.lng ?? '')
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return reply.status(400).send({ error: 'valid lat and lng required' })
      }

      const t0 = Date.now()

      try {
        const resultJson = await queryNoiseAtPoint(lat, lng)
        const raw = JSON.parse(resultJson)
        const elapsed = Date.now() - t0

        const elevation = Math.round(getElevation(lat, lng) * 10) / 10

        const sources = (raw.sources ?? []).map((s: any) => ({
          source_type: s.source_type,
          lden: s.periods?.lden_db ?? null,
          lden_free: s.periods_free?.lden_db ?? null,
          segment_count: s.segment_count ?? 0,
          displayed_count: s.displayed_count ?? 0,
        }))

        // Typed metadata (SourceMetadata enum from Rust) flows through unchanged.
        // Aircraft metadata is now Rust-side `SourceMetadata::Aircraft` (not a server-side bag),
        // so no flattening needed here.
        const topContributors = (raw.contributors ?? []).map((c: any) => {
          const screeningRaw = c.screening ?? { building_path_m: 0, attenuation_db: 0 }
          return {
            source_type: c.source_type,
            osm_id: c.osm_id ?? null,
            name: c.name ?? '',
            subtype: c.subtype ?? '',
            distance_m: Math.round(c.distance_m ?? 0),
            metadata: c.metadata ?? null,
            emission_db: c.emission_db ?? 0,
            emission_bands: c.emission_bands ?? [],
            baseline: c.baseline ?? { geometric_db: 0, atmospheric_db: 0, ground_factor: 0.5, ground_db: 0, total_db: 0 },
            terrain: c.terrain ?? { delta_m: 0, is_double: false, attenuation_db: 0 },
            screening: {
              building_path_m: screeningRaw.building_path_m ?? 0,
              attenuation_db: screeningRaw.attenuation_db ?? 0,
              obstacle: screeningRaw.obstacle ?? null,
            },
            vegetation: c.vegetation ?? { forest_depth_m: 0, attenuation_db: 0 },
            received_lden: Math.round((c.periods?.lden_db ?? c.received_lden ?? 0) * 10) / 10,
            received_lden_free: Math.round((c.periods_free?.lden_db ?? c.received_lden_free ?? 0) * 10) / 10,
            received_bands: c.received_bands ?? [],
            geometry: c.geometry ?? null,
          }
        })

        return reply.send({
          h3_index: '',
          h3_center: [lat, lng],
          elevation_m: elevation,
          total_lden: raw.total?.lden_db ?? null,
          total_lden_free: raw.total_free?.lden_db ?? null,
          sources,
          top_contributors: topContributors,
          compute_time_ms: elapsed,
        })
      } catch (err) {
        const message = (err as Error).message
        const statusCode = message.includes('timeout') ? 504 : 500
        return reply.status(statusCode).send({ error: message })
      }
    }
  )
}
