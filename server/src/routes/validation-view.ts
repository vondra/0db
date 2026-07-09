/**
 * Validation map view (owner request 2026-07-09): one page showing every
 * validation anchor — where it is, what external truth it carries and why,
 * how far our model sits from it, and what we measure there. Read-only over
 * committed validation artifacts + the last gate run; nothing here mutates
 * state.
 *
 *   GET /validation             the standalone MapLibre page
 *   GET /api/validation/points  merged payload: fixtures (benchmarks/
 *                               world-points.json + data/validation/
 *                               world-lastrun.json) and network stations
 *                               (benchmarks/validation/snapshots/*.json +
 *                               data/validation/deltas/*.json)
 */
import type { FastifyInstance } from 'fastify'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const POINTS_PATH = resolve(REPO_ROOT, 'benchmarks/world-points.json')
const LASTRUN_PATH = resolve(REPO_ROOT, 'data/validation/world-lastrun.json')
const SNAPSHOT_DIR = resolve(REPO_ROOT, 'benchmarks/validation/snapshots')
const DELTA_DIR = resolve(REPO_ROOT, 'data/validation/deltas')
const PAGE_PATH = resolve(import.meta.dirname, '../pages/validation.html')

const MODE_REGIME: Record<string, string> = {
  'source:road': 'road',
  'source:railway': 'rail',
  'source:aircraft': 'aircraft',
  'source:industrial': 'industrial_wind',
  'source:building': 'settlement',
}

type LastrunResult = { id: string; value: number | null; status: string; drift: number | null; ext: { delta: number; side: string } | null }

export async function validationViewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/validation/points', async (_request, reply) => {
    // Degraded inputs are SHOWN, not silently dropped — a checkout without
    // snapshots or a stale gate run must read as a red banner, not as
    // "everything is fine, 0 stations".
    const warnings: string[] = []
    const fixturesRaw = JSON.parse(readFileSync(POINTS_PATH, 'utf8')) as Record<string, unknown>[]
    const lastrun = existsSync(LASTRUN_PATH)
      ? (JSON.parse(readFileSync(LASTRUN_PATH, 'utf8')) as { server: string; commit: string; timestamp: string; data_year: number; results: LastrunResult[] })
      : null
    if (!lastrun) warnings.push('no gate run found (data/validation/world-lastrun.json) — run /check-world; fixtures show without model values')
    const byId = new Map((lastrun?.results ?? []).map((r) => [r.id, r]))

    const fixtures = fixturesRaw.map((p) => {
      const run = byId.get(p.id as string)
      return {
        kind: 'fixture',
        id: p.id,
        lat: p.lat,
        lng: p.lng,
        regime: p.mode === 'total' ? p.regime : MODE_REGIME[p.mode as string],
        mode: p.mode,
        metric_field: p.metric_field ?? 'lden',
        anchor_type: p.anchor_type,
        role: p.role,
        tags: p.tags,
        pair_id: p.pair_id ?? null,
        external: p.external,
        commensurability: p.commensurability,
        regression_band: p.regression_band ?? null,
        known_gap: p.known_gap ?? null,
        tolerance_note: p.tolerance_note,
        caveats: p.caveats ?? null,
        model_value: run?.value ?? null,
        status: run?.status ?? null,
        drift: run?.drift ?? null,
        ext: run?.ext ?? null,
      }
    })

    const networks = []
    if (!existsSync(SNAPSHOT_DIR)) {
      warnings.push('benchmarks/validation/snapshots/ missing — committed network snapshots not found in this checkout')
    } else {
      for (const file of readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.json')).sort()) {
        const snap = JSON.parse(readFileSync(resolve(SNAPSHOT_DIR, file), 'utf8')) as Record<string, unknown> & {
          network: string; year: number; stations: Record<string, unknown>[]
        }
        const deltaPath = resolve(DELTA_DIR, `${snap.network}.${snap.year}.json`)
        const delta = existsSync(deltaPath)
          ? (JSON.parse(readFileSync(deltaPath, 'utf8')) as { rows: Record<string, unknown>[]; generated_at: string; server: string; trend_only: boolean })
          : null
        const deltaById = new Map((delta?.rows ?? []).map((r) => [r.station_id as string, r]))
        networks.push({
          network: snap.network,
          year: snap.year,
          mode: snap.mode,
          license: snap.license,
          source: snap.source,
          commensurability: snap.commensurability,
          delta_meta: delta ? { generated_at: delta.generated_at, server: delta.server, trend_only: delta.trend_only } : null,
          stations: snap.stations
            .filter((st) => {
              const ok = Number.isFinite(st.lat) && Number.isFinite(st.lng)
              if (!ok) warnings.push(`${snap.network}/${st.station_id}: non-finite coords — hidden from the map`)
              return ok
            })
            .map((st) => {
              const d = deltaById.get(st.station_id as string)
              return {
                kind: 'station',
                network: snap.network,
                ...st,
                model: d?.model ?? null,
                delta_lden: d?.delta_lden ?? null,
                verdict: d?.verdict ?? null,
                dominant_source: d?.dominant_source ?? null,
              }
            }),
        })
      }
    }

    return reply.send({
      generated_at: new Date().toISOString(),
      lastrun: lastrun ? { server: lastrun.server, commit: lastrun.commit, timestamp: lastrun.timestamp, data_year: lastrun.data_year } : null,
      warnings,
      fixtures,
      networks,
    })
  })

  app.get('/validation', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(readFileSync(PAGE_PATH, 'utf8'))
  })
}
