/**
 * Query the popup model at every station in one approved external-measurement
 * snapshot and write a compact, re-derivable Δ artifact. Snapshot truth and
 * comparison policy stay only in the committed snapshot catalog; the artifact
 * contains raw model output and query status, keyed by station_id. Derived
 * deltas and verdicts are printed here and recomputed by each reader.
 *
 * Run: npx tsx pipeline/validation/delta-table.ts \
 *   --snapshot benchmarks/validation/snapshots/barcelona-xarxa-soroll.2025.json
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT, VALIDATION_DATA_DIR, validateSnapshot, type Snapshot } from './lib.ts'
import { classifyComparison, type ComparisonVerdict } from './comparison.ts'
import { loadApprovedSnapshots } from './snapshot-loader.mjs'
import { fetchModelCohort as fetchModelCohortShared, type ModelCohort } from './cohort-client.mjs'

const SERVER = process.env.CHECK_WORLD_SERVER || 'http://localhost:8520'
const CONCURRENCY = 2
const INSTANCE_HEADER = 'x-0db-instance'
const COHORT_TIMEOUT_MS = Number(process.env.CHECK_WORLD_COHORT_TIMEOUT_MS || '60000')
const snapshotIndex = process.argv.indexOf('--snapshot')
const snapshotArg = snapshotIndex >= 0 ? process.argv[snapshotIndex + 1] : null
if (!snapshotArg) {
  console.error('usage: npx tsx pipeline/validation/delta-table.ts --snapshot <benchmarks/validation/snapshots/*.json>')
  process.exit(2)
}

const requestedPath = resolve(snapshotArg)
const approved = loadApprovedSnapshots(REPO_ROOT).find(entry => entry.path === requestedPath)
if (!approved) {
  console.error(`[delta] ${snapshotArg} is not in benchmarks/validation/approved-snapshots.v1.json`)
  process.exit(2)
}
try {
  validateSnapshot(approved.snapshot, `snapshot ${snapshotArg}`)
} catch (error) {
  console.error(`[delta] ${error instanceof Error ? error.message : String(error)} — regenerate it with the current adapter`)
  process.exit(2)
}
const snapshot: Snapshot = approved.snapshot
const snapshotSha256 = createHash('sha256').update(readFileSync(approved.path)).digest('hex')

const health = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
if (!health?.ok) {
  console.error(`[delta] server ${SERVER} unreachable — set CHECK_WORLD_SERVER`)
  process.exit(2)
}
const serverInstance = health.headers.get(INSTANCE_HEADER)
if (!serverInstance) {
  console.error(`[delta] server ${SERVER} lacks ${INSTANCE_HEADER} coherence header`)
  process.exit(2)
}
let coherenceError: string | null = null
function requireSameInstance(response: Response, label: string): void {
  const actual = response.headers.get(INSTANCE_HEADER)
  if (actual !== serverInstance) {
    coherenceError ??= `${label}: server instance changed (${serverInstance} → ${actual ?? 'missing'})`
    throw new Error(coherenceError)
  }
}

// The /api/validation/cohort contract lives ONCE in cohort-client.mjs (shared with the
// /check-world skill's run.mjs — /simplify 2026-07-15); this wrapper only pins our SERVER,
// timeout, and the per-run instance-coherence check.
const fetchModelCohort = (label: string): Promise<ModelCohort> => fetchModelCohortShared({
  server: SERVER, timeoutMs: COHORT_TIMEOUT_MS, label, onResponse: requireSameInstance,
})

let modelCohort: ModelCohort
let modelCohortReceivedAt: number
try {
  modelCohort = await fetchModelCohort('initial model cohort')
  modelCohortReceivedAt = Date.now()
} catch (error) {
  console.error(`[delta] cannot establish model/data cohort (${error instanceof Error ? error.message : String(error)}) — refusing a potentially mixed run`)
  process.exit(2)
}

type ModelValues = { lden: number | null; ld: number | null; le: number | null; ln: number | null }
type Row = {
  station_id: string
  model: ModelValues
  query_status: 'ok' | 'no_coverage' | 'error'
  dominant_source: string | null
}
type WireSource = {
  source_type: string
  lden: number | null
  ld: number | null
  le: number | null
  ln: number | null
}

const emptyModel = (): ModelValues => ({ lden: null, ld: null, le: null, ln: null })
const rounded = (value: number | null): number | null => value == null ? null : +value.toFixed(1)

function totalPeriod(sources: WireSource[], field: 'ld' | 'le' | 'ln'): number | null {
  const values = sources.map(source => source[field]).filter((value): value is number => value != null)
  return values.length
    ? +(10 * Math.log10(values.reduce((sum, value) => sum + 10 ** (value / 10), 0))).toFixed(1)
    : null
}

async function queryStation(station: Snapshot['stations'][number]): Promise<Row> {
  const base = { station_id: station.station_id, model: emptyModel(), dominant_source: null }
  try {
    const response = await fetch(
      `${SERVER}/api/noise-onfly-v2?lat=${station.lat}&lng=${station.lng}`,
      { signal: AbortSignal.timeout(120000) },
    )
    requireSameInstance(response, station.station_id)
    if (!response.ok) return { ...base, query_status: 'error' }
    const body = await response.json() as { total_lden: number | null; sources: WireSource[] }
    if (!body.sources?.length || body.total_lden == null) return { ...base, query_status: 'no_coverage' }

    const dominant = body.sources
      .filter(source => source.lden != null)
      .sort((a, b) => b.lden! - a.lden!)[0]
    let model: ModelValues
    if (snapshot.mode === 'total') {
      model = {
        lden: rounded(body.total_lden),
        ld: totalPeriod(body.sources, 'ld'),
        le: totalPeriod(body.sources, 'le'),
        ln: totalPeriod(body.sources, 'ln'),
      }
    } else {
      const source = body.sources.find(item => item.source_type === snapshot.mode.replace('source:', ''))
      if (source?.lden == null) return { ...base, query_status: 'no_coverage' }
      model = { lden: rounded(source.lden), ld: rounded(source.ld), le: rounded(source.le), ln: rounded(source.ln) }
    }

    const modelValue = model[snapshot.model_metric_field]
    if (modelValue == null) return { ...base, model, query_status: 'no_coverage' }
    return {
      station_id: station.station_id,
      model,
      query_status: 'ok',
      dominant_source: dominant?.source_type ?? null,
    }
  } catch {
    return { ...base, query_status: 'error' }
  }
}

const rows: Row[] = new Array(snapshot.stations.length)
let next = 0
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < snapshot.stations.length) {
    const index = next++
    rows[index] = await queryStation(snapshot.stations[index])
    if ((index + 1) % 10 === 0) console.error(`  ${index + 1}/${snapshot.stations.length}`)
  }
}))

// Do not compare the cached initial fingerprint to itself on a very fast run.
const cohortCacheRemainingMs = modelCohort.cache_ttl_ms - (Date.now() - modelCohortReceivedAt)
if (cohortCacheRemainingMs > 0) {
  await new Promise(resolveWait => setTimeout(resolveWait, cohortCacheRemainingMs + 25))
}
try {
  const finalHealth = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(3000) })
  if (!finalHealth.ok) throw new Error(`HTTP ${finalHealth.status}`)
  requireSameInstance(finalHealth, 'final health check')
  const finalCohort = await fetchModelCohort('final model cohort')
  if (finalCohort.cohort_id !== modelCohort.cohort_id) {
    coherenceError ??= `model/data cohort changed (${modelCohort.cohort_id.slice(0, 12)} → ${finalCohort.cohort_id.slice(0, 12)})`
  }
} catch (error) {
  coherenceError ??= `final health check failed: ${error instanceof Error ? error.message : String(error)}`
}
if (coherenceError) {
  console.error(`[delta] ${coherenceError} — discarding the run rather than mixing model processes`)
  process.exit(2)
}

const comparisonLabel = snapshot.comparison_mode === 'trend_only'
  ? 'TREND ONLY: no commensurable absolute Δ'
  : snapshot.comparison_mode === 'upper_bound'
    ? `UPPER BOUND: model ≤ measured + ${snapshot.comparison_tolerance_db} dB`
    : `TWO SIDED: tolerance ±${snapshot.comparison_tolerance_db} dB`
const output = [
  '',
  `Δ table — ${snapshot.network} ${snapshot.year} vs ${SERVER} (${comparisonLabel})`,
  `model/data cohort ${modelCohort.cohort_id.slice(0, 12)}`,
]
output.push(`${'station'.padEnd(10)} ${'name'.padEnd(34)} ${snapshot.measured_metric_field.padStart(14)} ${snapshot.model_metric_field.padStart(12)} ${'Δdb'.padStart(6)}  ${'verdict'.padEnd(15)} dominant`)
const verdicts: Array<ComparisonVerdict | 'no_coverage'> = []
for (const [index, row] of rows.entries()) {
  const station = snapshot.stations[index]
  const measured = station[snapshot.measured_metric_field] as number
  const model = row.model[snapshot.model_metric_field]
  const compared = row.query_status === 'ok'
    ? classifyComparison(snapshot.comparison_mode, snapshot.comparison_tolerance_db, measured, model)
    : { delta_db: null, verdict: row.query_status }
  verdicts.push(compared.verdict)
  output.push(`${row.station_id.padEnd(10)} ${station.name.slice(0, 34).padEnd(34)} ${measured.toFixed(1).padStart(14)} ${(model == null ? '—' : model.toFixed(1)).padStart(12)} ${(compared.delta_db == null ? '—' : `${compared.delta_db >= 0 ? '+' : ''}${compared.delta_db.toFixed(1)}`).padStart(6)}  ${compared.verdict.padEnd(15)} ${row.dominant_source ?? '—'}`)
}
const counts: Record<string, number> = {}
for (const verdict of verdicts) counts[verdict] = (counts[verdict] ?? 0) + 1
output.push(`summary: ${Object.entries(counts).map(([status, count]) => `${status} ${count}`).join('  ')}`)
console.log(output.join('\n'))

const deltaDir = resolve(VALIDATION_DATA_DIR, 'deltas')
mkdirSync(deltaDir, { recursive: true })
const outPath = resolve(deltaDir, `${snapshot.network}.${snapshot.year}.json`)
const temporary = `${outPath}.tmp-${process.pid}`
try {
  writeFileSync(temporary, JSON.stringify({
    schema_version: 2,
    network: snapshot.network,
    year: snapshot.year,
    server: SERVER,
    generated_at: new Date().toISOString(),
    snapshot_sha256: snapshotSha256,
    model_cohort: modelCohort.cohort_id,
    rows,
  }, null, 2) + '\n', { flag: 'wx' })
  renameSync(temporary, outPath)
} finally {
  rmSync(temporary, { force: true })
}
console.error(`[delta] → ${outPath}`)
