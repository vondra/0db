/**
 * On-the-fly noise computation v2 — unified Rust engine.
 */

import type { FastifyInstance } from 'fastify'
import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { getElevation } from '../engine/dem-reader.js'
import {
  NoiseOnflyRequestError,
  NoiseOnflySupervisor,
} from '../engine/noise-onfly-supervisor.js'

const SOURCE_READER_PATH = resolve(import.meta.dirname, '../../../engine/source-reader/target/release/libsource_reader.so')
const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = process.env.H3R4_DIR || resolve(import.meta.dirname, `../../../data/prepared/${YEAR}/h3r4`)
const WORKER_URL = new URL('../workers/noise-onfly-worker.mjs', import.meta.url)
const NOISE_ONFLY_WORK_TIMEOUT_MS = Number(process.env.NOISE_ONFLY_WORK_TIMEOUT_MS || '30000')
const NOISE_ONFLY_QUEUE_TIMEOUT_MS = Number(process.env.NOISE_ONFLY_QUEUE_TIMEOUT_MS || '10000')
const NOISE_ONFLY_MAX_QUEUE = Number(process.env.NOISE_ONFLY_MAX_QUEUE || '8')

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

  app.get<{ Querystring: { lat?: string; lng?: string } }>(
    '/api/noise-onfly-v2',
    async (request, reply) => {
      const lat = parseFloat(request.query.lat ?? '')
      const lng = parseFloat(request.query.lng ?? '')
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return reply.status(400).send({ error: 'valid lat and lng required' })
      }

      const t0 = Date.now()
      const abortController = new AbortController()
      const onClose = () => {
        abortController.abort()
      }
      request.raw.once('close', onClose)

      try {
        const resultJson = await supervisor.queryNoiseAtPoint(lat, lng, abortController.signal)
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
          other_sources_lden: raw.other_sources_lden ?? null,
          compute_time_ms: elapsed,
        })
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
