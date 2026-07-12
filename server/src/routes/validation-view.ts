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
 *                               (approved snapshot manifest +
 *                               data/validation/deltas/*.json)
 */
import type { FastifyInstance } from 'fastify'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { loadApprovedSnapshots } from '../validation-runtime/snapshot-loader.mjs'
import { parseServerIdentity, type ServerRuntimeIdentity } from '../validation-runtime/server-identity.mjs'
import { classifyComparison, type ComparisonMode } from '../validation-runtime/comparison-runtime.mjs'
import {
  networkHoldoutKey,
  partitionForHoldoutKey,
  validateHoldoutManifest,
  worldHoldoutKey,
  type HoldoutManifest,
  type HoldoutPartition,
} from '../validation-runtime/holdouts-runtime.mjs'
import {
  createCurrentRuntimeIdentityProvider,
  type CurrentRuntimeIdentityProvider,
} from '../current-runtime-identity.js'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const POINTS_PATH = resolve(REPO_ROOT, 'benchmarks/world-points.json')
const LASTRUN_PATH = resolve(REPO_ROOT, 'data/validation/world-lastrun.json')
const DELTA_DIR = resolve(REPO_ROOT, 'data/validation/deltas')
const HOLDOUT_MANIFEST_PATH = resolve(REPO_ROOT, 'benchmarks/validation/holdout-manifest.v1.json')
const PAGE_PATH = resolve(import.meta.dirname, '../pages/validation.html')

const MODE_REGIME: Record<string, string> = {
  'source:road': 'road',
  'source:railway': 'rail',
  'source:aircraft': 'aircraft',
  'source:industrial': 'industrial_wind',
  'source:building': 'settlement',
}

type LastrunResult = { id: string; partition: string; value: number | null; status: string; drift: number | null; ext: { delta: number; side: string } | null }
type ValidationLastrun = {
  schema_version: 1
  server: string
  commit: string
  timestamp: string
  data_year: number
  server_identity: unknown
  fixtures_sha256: string
  holdout_manifest_sha256: string
  evaluate_holdout: false
  results: LastrunResult[]
}

type ValidationSnapshot = Record<string, unknown> & {
  network: string
  year: number
  stations: Record<string, unknown>[]
  comparison_mode: ComparisonMode
  comparison_tolerance_db: number | null
  comparison_tolerance_basis: string | null
  measured_metric_field: string
  model_metric_field: string
}

type ValidationDelta = {
  schema_version: 1
  network: string
  year: number
  rows: Record<string, unknown>[]
  generated_at: string
  server: string
  trend_only: boolean
  comparison_mode: string
  comparison_tolerance_db: number | null
  comparison_tolerance_basis: string | null
  measured_metric_field: string
  model_metric_field: string
  evaluate_holdout: false
  server_identity: unknown
  snapshot_sha256: string
  holdout_manifest_sha256: string
}

type ArtifactContext = {
  currentServerIdentity: ServerRuntimeIdentity | null
  holdoutManifestSha256: string
}

type LastrunContext = ArtifactContext & {
  fixturesSha256: string
  partitionById: Map<string, HoldoutPartition>
}

type DeltaContext = ArtifactContext & {
  snapshotSha256: string
  partitionById: Map<string, HoldoutPartition>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameIdentity(a: ServerRuntimeIdentity, b: ServerRuntimeIdentity): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || Number.isFinite(value)
}

function externalGapError(value: unknown): string | null {
  if (value === null) return null
  if (!isRecord(value)) return 'ext must be null or an object'
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'delta' || keys[1] !== 'side') return 'ext has unexpected fields'
  if (!Number.isFinite(value.delta)) return 'ext.delta must be finite'
  if (!['within', 'above', 'below', 'below-unattributable'].includes(value.side as string)) return 'ext.side is invalid'
  return null
}

export function validationLastrunCompatibilityError(value: unknown, context: LastrunContext): string | null {
  if (!isRecord(value) || value.schema_version !== 1) return 'missing or unsupported schema_version'
  if (value.evaluate_holdout !== false) return 'holdout evaluation may not enter the public validation view'
  if (value.fixtures_sha256 !== context.fixturesSha256) return 'fixture content hash mismatch'
  if (value.holdout_manifest_sha256 !== context.holdoutManifestSha256) return 'holdout manifest hash mismatch'
  if (!context.currentServerIdentity) return 'current server runtime identity unavailable'
  if (!context.currentServerIdentity.identity_complete) return 'current server prepared-data identity is incomplete'
  let identity
  try {
    identity = parseServerIdentity(value.server_identity, 'gate server_identity')
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid server_identity'
  }
  if (!sameIdentity(identity, context.currentServerIdentity)) return 'artifact belongs to a different server runtime identity'
  if (value.commit !== (identity.build.git_commit ?? 'unknown')) return 'commit differs from server_identity'
  if (value.data_year !== Number(identity.data_year)) return 'data_year differs from server_identity'
  if (typeof value.server !== 'string' || value.server.length === 0) return 'invalid server'
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) return 'invalid timestamp'
  if (!Array.isArray(value.results) || value.results.length !== context.partitionById.size) return 'fixture result count mismatch'
  const expected = new Set(context.partitionById.keys())
  const seen = new Set<string>()
  const statuses = new Set(['ERROR', 'SKIPPED', 'WITHHELD', 'DRIFT', 'KNOWN-GAP', 'PENDING', 'EXTERNAL-GAP', 'OK'])
  for (const result of value.results) {
    if (!isRecord(result) || typeof result.id !== 'string' || !expected.has(result.id) || seen.has(result.id)) {
      return 'fixture results are missing, extra or duplicated'
    }
    seen.add(result.id)
    if (result.partition !== context.partitionById.get(result.id)) return `fixture ${result.id} partition differs from the holdout manifest`
    if (typeof result.status !== 'string' || !statuses.has(result.status)) return `fixture ${result.id} has an invalid status`
    if (!isFiniteOrNull(result.value)) return `fixture ${result.id} has an invalid value`
    if (!isFiniteOrNull(result.drift)) return `fixture ${result.id} has an invalid drift`
    const extError = externalGapError(result.ext)
    if (extError) return `fixture ${result.id} ${extError}`
    if (result.partition === 'holdout'
      && (result.status !== 'WITHHELD' || result.value !== null || result.drift !== null || result.ext !== null)) {
      return `fixture ${result.id} exposes a holdout value`
    }
    if (result.partition !== 'holdout' && result.status === 'WITHHELD') return `fixture ${result.id} is unexpectedly withheld`
  }
  return null
}

/** Reject stale, evaluated or semantically incompatible local deltas. */
export function validationDeltaCompatibilityError(value: unknown, snapshot: ValidationSnapshot, context: DeltaContext): string | null {
  if (!isRecord(value)) return 'artifact is not an object'
  if (value.schema_version !== 1) return 'missing or unsupported schema_version'
  if (value.network !== snapshot.network || value.year !== snapshot.year) return 'network/year mismatch'
  if (value.evaluate_holdout !== false) return 'holdout evaluation may not enter the public validation view'
  if (value.snapshot_sha256 !== context.snapshotSha256) return 'approved snapshot content hash mismatch'
  if (value.holdout_manifest_sha256 !== context.holdoutManifestSha256) return 'holdout manifest hash mismatch'
  if (!context.currentServerIdentity) return 'current server runtime identity unavailable'
  if (!context.currentServerIdentity.identity_complete) return 'current server prepared-data identity is incomplete'
  if (value.trend_only !== (snapshot.comparison_mode === 'trend_only')) return 'trend_only compatibility flag differs from the approved snapshot'
  for (const field of [
    'comparison_mode', 'comparison_tolerance_db', 'comparison_tolerance_basis',
    'measured_metric_field', 'model_metric_field',
  ] as const) {
    if (value[field] !== snapshot[field]) return `${field} differs from the approved snapshot`
  }
  if (typeof value.generated_at !== 'string' || !Number.isFinite(Date.parse(value.generated_at))) return 'invalid generated_at'
  if (typeof value.server !== 'string' || value.server.length === 0) return 'invalid server'
  let identity
  try {
    identity = parseServerIdentity(value.server_identity, 'delta server_identity')
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid server_identity'
  }
  if (!sameIdentity(identity, context.currentServerIdentity)) return 'artifact belongs to a different server runtime identity'
  if (!Array.isArray(value.rows) || value.rows.length !== snapshot.stations.length) return 'station row count mismatch'
  const expectedIds = new Set(snapshot.stations.map(station => station.station_id))
  const stationById = new Map(snapshot.stations.map(station => [station.station_id, station]))
  const seen = new Set<unknown>()
  const verdicts = new Set(['above', 'within_bound', 'below', 'unattributable', 'trend_only', 'error', 'holdout_withheld', 'no_coverage'])
  for (const row of value.rows) {
    if (!isRecord(row) || typeof row.station_id !== 'string' || !expectedIds.has(row.station_id) || seen.has(row.station_id)) {
      return 'station rows are missing, extra or duplicated'
    }
    seen.add(row.station_id)
    if (row.measured_metric_field !== snapshot.measured_metric_field || row.model_metric_field !== snapshot.model_metric_field) {
      return `station ${row.station_id} metric fields differ from the approved snapshot`
    }
    if (row.partition !== context.partitionById.get(row.station_id)) return `station ${row.station_id} partition differs from the holdout manifest`
    if (typeof row.verdict !== 'string' || !verdicts.has(row.verdict)) return `station ${row.station_id} has an invalid verdict`
    for (const field of ['measured_value', 'model_value', 'delta_db', 'delta_lden'] as const) {
      if (row[field] !== null && !Number.isFinite(row[field])) return `station ${row.station_id} has an invalid ${field}`
    }
    const station = stationById.get(row.station_id)!
    const measuredValue = station[snapshot.measured_metric_field]
    if (!Number.isFinite(measuredValue) || row.measured_value !== measuredValue) return `station ${row.station_id} measured value differs from the approved snapshot`
    if (!isRecord(row.model)) return `station ${row.station_id} has an invalid model payload`
    if (Object.values(row.model).some(modelValue => modelValue !== null && !Number.isFinite(modelValue))) {
      return `station ${row.station_id} has a non-finite model payload`
    }
    if (row.dominant_source !== null && typeof row.dominant_source !== 'string') return `station ${row.station_id} has an invalid dominant_source`
    if (row.partition === 'holdout') {
      if (row.verdict !== 'holdout_withheld' || row.model_value !== null || row.delta_db !== null
        || row.delta_lden !== null || row.dominant_source !== null || Object.values(row.model).some(model => model !== null)) {
        return `station ${row.station_id} exposes a holdout value`
      }
      continue
    }
    const modelValue = row.model[snapshot.model_metric_field]
    if (row.model_value !== modelValue) return `station ${row.station_id} model_value differs from its model payload`
    if (modelValue === null) {
      if (!['error', 'no_coverage'].includes(row.verdict as string) || row.delta_db !== null || row.delta_lden !== null) {
        return `station ${row.station_id} has contradictory missing-model semantics`
      }
      continue
    }
    if (!Number.isFinite(modelValue)) return `station ${row.station_id} has an invalid primary model value`
    const expectedComparison = classifyComparison(
      snapshot.comparison_mode,
      snapshot.comparison_tolerance_db,
      measuredValue as number,
      modelValue as number,
    )
    const expectedLdenDelta = snapshot.measured_metric_field === 'lden' && snapshot.model_metric_field === 'lden'
      ? expectedComparison.delta_db : null
    if (row.verdict !== expectedComparison.verdict || row.delta_db !== expectedComparison.delta_db || row.delta_lden !== expectedLdenDelta) {
      return `station ${row.station_id} delta/verdict contradict the approved comparison semantics`
    }
  }
  return null
}

type ValidationViewRouteOptions = {
  runtimeIdentityProvider?: CurrentRuntimeIdentityProvider
}

export async function validationViewRoutes(
  app: FastifyInstance,
  options: ValidationViewRouteOptions = {},
): Promise<void> {
  const identityProvider = options.runtimeIdentityProvider
    ?? createCurrentRuntimeIdentityProvider()
  app.get('/api/validation/points', async (_request, reply) => {
    // Degraded inputs are SHOWN, not silently dropped — a checkout without
    // snapshots or a stale gate run must read as a red banner, not as
    // "everything is fine, 0 stations".
    const warnings: string[] = []
    const fixturesBytes = readFileSync(POINTS_PATH)
    const fixturesRaw = JSON.parse(fixturesBytes.toString('utf8')) as Record<string, unknown>[]
    const holdoutManifestBytes = readFileSync(HOLDOUT_MANIFEST_PATH)
    const parsedHoldoutManifest: unknown = JSON.parse(holdoutManifestBytes.toString('utf8'))
    validateHoldoutManifest(parsedHoldoutManifest, HOLDOUT_MANIFEST_PATH)
    const holdoutManifest: HoldoutManifest = parsedHoldoutManifest
    const currentRuntime = await identityProvider()
    const artifactContext: ArtifactContext = {
      currentServerIdentity: currentRuntime.identity ?? null,
      holdoutManifestSha256: sha256(holdoutManifestBytes),
    }
    if (!artifactContext.currentServerIdentity) {
      warnings.push('current server runtime identity unavailable — model artifacts are hidden')
    } else if (!artifactContext.currentServerIdentity.identity_complete) {
      warnings.push('prepared-data revision unavailable — unpinned model artifacts are hidden')
    }
    const fixturePartitions = new Map(fixturesRaw.map(fixture => {
      const id = String(fixture.id)
      return [id, partitionForHoldoutKey(worldHoldoutKey(id), holdoutManifest)] as const
    }))
    let lastrun: ValidationLastrun | null = null
    if (existsSync(LASTRUN_PATH)) {
      try {
        const candidate: unknown = JSON.parse(readFileSync(LASTRUN_PATH, 'utf8'))
        const incompatibility = validationLastrunCompatibilityError(
          candidate,
          {
            ...artifactContext,
            fixturesSha256: sha256(fixturesBytes),
            partitionById: fixturePartitions,
          },
        )
        if (incompatibility) warnings.push(`stale gate run ignored — ${incompatibility}; run /check-world`)
        else lastrun = candidate as ValidationLastrun
      } catch (error) {
        warnings.push(`unreadable gate run ignored — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
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
    for (const { file, path, snapshot: rawSnapshot } of loadApprovedSnapshots(REPO_ROOT)) {
        const snap = rawSnapshot as ValidationSnapshot
        const stationPartitions = new Map(snap.stations.map(station => {
          const id = String(station.station_id)
          return [id, partitionForHoldoutKey(networkHoldoutKey(snap.network, id), holdoutManifest)] as const
        }))
        const deltaPath = resolve(DELTA_DIR, file)
        let delta: ValidationDelta | null = null
        if (existsSync(deltaPath)) {
          try {
            const candidate: unknown = JSON.parse(readFileSync(deltaPath, 'utf8'))
            const incompatibility = validationDeltaCompatibilityError(candidate, snap, {
              ...artifactContext,
              snapshotSha256: sha256(readFileSync(path)),
              partitionById: stationPartitions,
            })
            if (incompatibility) warnings.push(`${file}: stale delta ignored — ${incompatibility}; regenerate it`)
            else delta = candidate as ValidationDelta
          } catch (error) {
            warnings.push(`${file}: unreadable delta ignored — ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        const deltaById = new Map((delta?.rows ?? []).map((r) => [r.station_id as string, r]))
        networks.push({
          network: snap.network,
          year: snap.year,
          mode: snap.mode,
          license: snap.license,
          source: snap.source,
          commensurability: snap.commensurability,
          comparison_mode: snap.comparison_mode,
          comparison_tolerance_db: snap.comparison_tolerance_db,
          comparison_tolerance_basis: snap.comparison_tolerance_basis,
          measured_metric_field: snap.measured_metric_field,
          model_metric_field: snap.model_metric_field,
          delta_meta: delta ? {
            generated_at: delta.generated_at,
            server: delta.server,
            trend_only: delta.trend_only,
            comparison_mode: delta.comparison_mode,
            comparison_tolerance_db: delta.comparison_tolerance_db,
            comparison_tolerance_basis: delta.comparison_tolerance_basis,
            measured_metric_field: delta.measured_metric_field,
            model_metric_field: delta.model_metric_field,
            server_identity: parseServerIdentity(delta.server_identity, 'delta server_identity'),
          } : null,
          stations: snap.stations
            .filter((st) => {
              const ok = Number.isFinite(st.lat) && Number.isFinite(st.lng)
              if (!ok) warnings.push(`${snap.network}/${st.station_id}: non-finite coords — hidden from the map`)
              return ok
            })
            .map((st) => {
              const d = deltaById.get(st.station_id as string)
              return {
                ...st,
                kind: 'station',
                network: snap.network,
                model: d?.model ?? null,
                measured_metric_field: d?.measured_metric_field ?? snap.measured_metric_field,
                model_metric_field: d?.model_metric_field ?? snap.model_metric_field,
                measured_value: d?.measured_value ?? st[snap.measured_metric_field],
                model_value: d?.model_value ?? (d?.model as Record<string, unknown> | undefined)?.[snap.model_metric_field] ?? null,
                delta_db: d?.delta_db ?? d?.delta_lden ?? null,
                delta_lden: d?.delta_lden ?? null,
                verdict: d?.verdict ?? null,
                dominant_source: d?.dominant_source ?? null,
              }
            }),
        })
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
