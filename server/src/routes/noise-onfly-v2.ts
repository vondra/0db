/**
 * On-the-fly noise computation v2 — unified Rust engine.
 */

import type { FastifyInstance } from 'fastify'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
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
  const nodePath = SOURCE_READER_PATH.replace('.so', '.node')
  if (!existsSync(nodePath) && existsSync(SOURCE_READER_PATH)) {
    const { symlinkSync } = await import('node:fs')
    try { symlinkSync(SOURCE_READER_PATH, nodePath) } catch {}
  }
  if (existsSync(nodePath) || existsSync(SOURCE_READER_PATH)) {
    sourceModule = req(existsSync(nodePath) ? nodePath : SOURCE_READER_PATH)
    if (sourceModule && existsSync(H3R4_DIR)) {
      const msg = sourceModule.sourceInit(H3R4_DIR)
      console.log(`noise-onfly-v2: ${msg}`)
    }
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

        const ad = raw.aircraft_detail
        const aircraftMeta = ad ? {
          v33: 1,
          l_day: ad.l_day ?? 0,
          l_evening: ad.l_evening ?? 0,
          l_night: ad.l_night ?? 0,
          lmax_peak: ad.lmax_peak ?? null,
          flights_per_day: ad.flights_per_day ?? 0,
          helicopter_flights_per_day: ad.helicopter_flights_per_day ?? 0,
          faint_flights_per_day: ad.faint_flights_per_day ?? 0,
          faint_avg_altitude_m: ad.faint_avg_altitude_m ?? 0,
          faint_top_aircraft: ad.faint_top_aircraft ?? '',
          audible_flights_per_day: ad.audible_flights_per_day ?? 0,
          audible_avg_altitude_m: ad.audible_avg_altitude_m ?? 0,
          audible_top_aircraft: ad.audible_top_aircraft ?? '',
          disruptive_flights_per_day: ad.disruptive_flights_per_day ?? 0,
          disruptive_avg_altitude_m: ad.disruptive_avg_altitude_m ?? 0,
          disruptive_top_aircraft: ad.disruptive_top_aircraft ?? '',
          elevation_m: elevation,
          compute_ms: elapsed,
        } : null

        let isFirstAircraft = true
        const topContributors = (raw.contributors ?? []).map((c: any) => {
          const isAircraft = c.source_type === 'aircraft'
          const metadata = (isAircraft && isFirstAircraft && aircraftMeta)
            ? (isFirstAircraft = false, aircraftMeta)
            : (c.metadata ?? {})

          return {
            source_type: c.source_type,
            osm_id: c.osm_id ?? null,
            name: c.name ?? '',
            subtype: c.subtype ?? '',
            distance_m: Math.round(c.distance_m ?? 0),
            metadata,
            emission_db: c.emission_db ?? 0,
            emission_bands: c.emission_bands ?? [],
            baseline: c.baseline ?? { geometric_db: 0, atmospheric_db: 0, ground_factor: 0.5, ground_db: 0, total_db: 0 },
            terrain: c.terrain ?? { delta_m: 0, is_double: false, attenuation_db: 0 },
            screening: c.screening ?? { building_path_m: 0, attenuation_db: 0 },
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
