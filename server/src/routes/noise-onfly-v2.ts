/**
 * On-the-fly noise computation v2 — unified Rust engine.
 */

import type { FastifyInstance } from 'fastify'
import { resolve } from 'node:path'
import { existsSync, lstatSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { getElevation } from '../engine/dem-reader.js'

const req = createRequire(import.meta.url)
let sourceModule: {
  sourceInit: (dir: string) => string
  queryNoiseAtPoint: (lat: number, lng: number) => string
} | null = null

const SOURCE_READER_PATH = resolve(import.meta.dirname, '../../../engine/source-reader/target/release/libsource_reader.so')
const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = process.env.H3R4_DIR || resolve(import.meta.dirname, `../../../data/prepared/${YEAR}/h3r4`)

try {
  const { copyFileSync, statSync } = await import('node:fs')
  const nodePath = SOURCE_READER_PATH.replace('.so', '.node')

  if (!existsSync(SOURCE_READER_PATH)) {
    throw new Error(
      `libsource_reader.so not found — run: cd engine/source-reader && cargo build --release`,
    )
  }

  if (existsSync(nodePath) && lstatSync(nodePath).isSymbolicLink()) {
    unlinkSync(nodePath)
  }

  // Always copy so every server start dlopens the latest cargo build.
  // The prior guarded copy kept a stale .node once it existed.
  copyFileSync(SOURCE_READER_PATH, nodePath)

  const st = statSync(SOURCE_READER_PATH)
  console.log(
    `noise-onfly-v2: loaded ${nodePath} ` +
    `(mtime=${st.mtime.toISOString()} size=${st.size})`,
  )

  sourceModule = req(nodePath)
  if (sourceModule && existsSync(H3R4_DIR)) {
    const msg = sourceModule.sourceInit(H3R4_DIR)
    console.log(`noise-onfly-v2: ${msg}`)
  }
} catch (err) {
  console.warn('noise-onfly-v2: source-reader not available:', (err as Error).message)
}

export async function noiseOnflyV2Routes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { lat?: string; lng?: string } }>(
    '/api/noise-onfly-v2',
    async (request, reply) => {
      if (!sourceModule) {
        return reply.status(503).send({ error: 'source-reader not initialized' })
      }

      const lat = parseFloat(request.query.lat ?? '')
      const lng = parseFloat(request.query.lng ?? '')
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return reply.status(400).send({ error: 'valid lat and lng required' })
      }

      const t0 = Date.now()

      try {
        const resultJson = sourceModule.queryNoiseAtPoint(lat, lng)
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
        return reply.status(500).send({ error: (err as Error).message })
      }
    }
  )
}
