// GET /api/initial-view — city-level first-map-view guess from the client IP.
//
// Feeds the frontend's initial view (frontend utils/initial-view.ts): a
// visitor with no shared #hash link starts at their CITY instead of a
// language-guessed country (owner report 2026-07-16: Prague visitor landed
// on a whole-country view). City accuracy is deliberate — precise GPS stays
// a user-triggered gesture on the map's locate button.
//
// Data: DB-IP City Lite mmdb (CC-BY 4.0 — attribution lives on the About
// page; refreshed monthly by scripts/update-geoip-db.sh). The database is
// OPTIONAL: absent or unreadable means every response is {source:'none'}
// and the frontend keeps its language fallback — a fresh checkout works
// without it. The lookup is in-memory only; neither the IP nor the result
// is ever stored (About → Privacy documents this).

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Reader, type CityResponse } from 'mmdb-lib'
import { REPO_ROOT } from '../runtime-paths.js'

// The whole metro area on screen: z11 shows a capital end-to-end while the
// district-level noise structure stays readable.
const CITY_ZOOM = 11

export const DEFAULT_GEOIP_DB_PATH = resolve(REPO_ROOT, 'data', 'prepared', 'geoip', 'dbip-city-lite.mmdb')

export async function initialViewRoutes(
  app: FastifyInstance,
  // Fastify's register() always passes an options OBJECT as the second
  // argument — a bare `databasePath: string` parameter would silently
  // receive `{}` and break the readFile (found live 2026-07-16).
  opts: { databasePath?: string } = {},
): Promise<void> {
  const databasePath = opts.databasePath ?? DEFAULT_GEOIP_DB_PATH
  // One ~130 MB buffer per process, loaded lazily on the first request so a
  // checkout without the database boots identically; `null` = feature off.
  // The PROMISE is memoized (not the result) so N concurrent cold-start
  // requests share one readFile instead of N × 130 MB peaks.
  let readerPromise: Promise<Reader<CityResponse> | null> | undefined
  function getReader(): Promise<Reader<CityResponse> | null> {
    readerPromise ??= readFile(databasePath)
      .then((buffer) => new Reader<CityResponse>(buffer))
      .catch(() => {
        app.log.warn(`initial-view: GeoIP database missing/unreadable at ${databasePath} — serving source:'none'`)
        return null
      })
    return readerPromise
  }

  app.get('/api/initial-view', async (request, reply) => {
    // The answer depends on the caller's IP — never let a shared cache keep it.
    reply.header('Cache-Control', 'private, no-store')
    let record: CityResponse | null = null
    try {
      record = (await getReader())?.get(request.ip) ?? null
    } catch {
      // Unparseable peer address (or a corrupt db node) — same as no match.
    }
    const lat = record?.location?.latitude
    const lng = record?.location?.longitude
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return { source: 'none' }
    }
    return { source: 'ip-city', lat, lng, zoom: CITY_ZOOM }
  })
}
