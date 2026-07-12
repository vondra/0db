/**
 * Leg A Δ table: model vs a committed network snapshot
 * (benchmarks/validation/snapshots/{network}.{year}.json). Queries the popup
 * (noise-onfly-v2) at every snapshot station — ≤2 concurrent, read-only —
 * and writes data/validation/deltas/{network}.{year}.json plus a console
 * table. Regenerated per snapshot; consumed by the uncertainty table later.
 *
 * The snapshot declares comparison semantics explicitly; they are never
 * inferred from metric_variant or dominance:
 *  - upper_bound (Barcelona/Dublin): Δ = model total_lden −
 *    measured lden per END period too; the ASYMMETRIC rule applies — only
 *    model > measured + U is a gap (model_total ≤ measured + U); model below
 *    ambient is unattributable, not model error. Composition column shows the
 *    dominant modelled source next to the station's Font tag.
 *  - two_sided: independently source-classified measurements may be high or
 *    low relative to the model, with the snapshot's stated tolerance.
 *  - trend_only (ZRH/EBA): no honest Δ — both series are
 *    reported side by side as a TREND anchor (trend_only: true).
 *
 * Future holdout stations are withheld by default. Their model value may be
 * revealed only by an intentional evaluation run with --evaluate-holdout;
 * that run writes under data/validation/holdout-evaluations/, never the
 * ordinary delta path consumed by the validation UI.
 *
 * Run: npx tsx pipeline/validation/delta-table.ts --snapshot benchmarks/validation/snapshots/barcelona-xarxa-soroll.2025.json
 *      [CHECK_WORLD_SERVER=http://localhost:8531]
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { REPO_ROOT, VALIDATION_DATA_DIR, validateSnapshot, type Snapshot } from './lib.ts'
import {
  networkHoldoutKey,
  partitionForHoldoutKey,
  shouldEvaluatePartition,
  validateHoldoutManifest,
  type HoldoutManifest,
  type HoldoutPartition,
} from './holdouts.ts'
import { classifyComparison, type ComparisonVerdict } from './comparison.ts'
import { loadApprovedSnapshots } from './snapshot-loader.mjs'
import { assertServerIdentityStable, fetchServerIdentity } from './server-identity.mjs'

const SERVER = process.env.CHECK_WORLD_SERVER || 'http://localhost:8520'
const CONCURRENCY = 2
const EVALUATE_HOLDOUT = process.argv.includes('--evaluate-holdout')
const HOLDOUT_MANIFEST_PATH = resolve(REPO_ROOT, 'benchmarks/validation/holdout-manifest.v1.json')
const parsedHoldoutManifest: unknown = JSON.parse(readFileSync(HOLDOUT_MANIFEST_PATH, 'utf8'))
validateHoldoutManifest(parsedHoldoutManifest, HOLDOUT_MANIFEST_PATH)
const holdoutManifest: HoldoutManifest = parsedHoldoutManifest
const holdoutManifestSha256 = createHash('sha256').update(readFileSync(HOLDOUT_MANIFEST_PATH)).digest('hex')

const snapArg = process.argv[process.argv.indexOf('--snapshot') + 1]
if (!snapArg) {
  console.error('usage: npx tsx pipeline/validation/delta-table.ts --snapshot <benchmarks/validation/snapshots/*.json> [--evaluate-holdout]')
  process.exit(2)
}
const requestedSnapshotPath = resolve(snapArg)
const approvedSnapshot = loadApprovedSnapshots(REPO_ROOT)
  .find(entry => entry.path === requestedSnapshotPath)
if (!approvedSnapshot) {
  console.error(`[delta] ${snapArg} is not in benchmarks/validation/approved-snapshots.v1.json`)
  process.exit(2)
}
const parsedSnapshot: unknown = approvedSnapshot.snapshot
const snapshotSha256 = createHash('sha256').update(readFileSync(approvedSnapshot.path)).digest('hex')
try {
  validateSnapshot(parsedSnapshot, `snapshot ${snapArg}`)
} catch (error) {
  console.error(`[delta] ${error instanceof Error ? error.message : String(error)} — regenerate it with the current adapter`)
  process.exit(2)
}
const snapshot: Snapshot = parsedSnapshot
const trendOnly = snapshot.comparison_mode === 'trend_only'
const toleranceDb = snapshot.comparison_tolerance_db

let serverIdentityBefore
try {
  serverIdentityBefore = await fetchServerIdentity(SERVER)
} catch (error) {
  console.error(`[delta] cannot identify server ${SERVER}: ${error instanceof Error ? error.message : String(error)} — run the compiled immutable server`)
  process.exit(2)
}
if (!serverIdentityBefore.identity_complete) {
  console.error('[delta] warning: prepared-data revision is unavailable; this artifact is diagnostic and ineligible for headline uncertainty')
}
if (serverIdentityBefore.build.git_dirty !== false) {
  console.error('[delta] warning: server build is dirty or its dirty state is unknown; uncertainty aggregation must reject this artifact')
}

const health = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
if (!health?.ok) {
  console.error(`[delta] server ${SERVER} unreachable — set CHECK_WORLD_SERVER`)
  process.exit(2)
}

type Row = {
  station_id: string
  name: string
  measured: Record<string, number | null>
  model: Record<string, number | null>
  measured_metric_field: string
  model_metric_field: string
  measured_value: number | null
  model_value: number | null
  dominant_source: string | null
  font?: string
  partition: HoldoutPartition
  delta_db: number | null
  delta_lden: number | null
  verdict: ComparisonVerdict | 'holdout_withheld' | 'no_coverage'
}

async function queryStation(st: Snapshot['stations'][number]): Promise<Row> {
  const partition = partitionForHoldoutKey(networkHoldoutKey(snapshot.network, st.station_id), holdoutManifest)
  const measured = {
    lden: (st.lden as number) ?? null, ld: (st.ld as number) ?? null,
    le: (st.le as number) ?? null, ln: (st.ln as number) ?? null,
    laeq: (st.laeq as number) ?? null,
    laeq_24h: (st.laeq_24h as number) ?? null,
    laeq_tag_0622: (st.laeq_tag_0622 as number) ?? null,
    laeq_nacht_2206: (st.laeq_nacht_2206 as number) ?? null,
  }
  const base: Omit<Row, 'delta_db' | 'delta_lden' | 'verdict'> = {
    station_id: st.station_id, name: st.name, measured,
    model: { lden: null, ld: null, le: null, ln: null },
    measured_metric_field: snapshot.measured_metric_field,
    model_metric_field: snapshot.model_metric_field,
    measured_value: Number.isFinite(st[snapshot.measured_metric_field]) ? st[snapshot.measured_metric_field] as number : null,
    model_value: null,
    dominant_source: null, font: st.font as string | undefined, partition,
  }
  if (!shouldEvaluatePartition(partition, EVALUATE_HOLDOUT)) {
    return { ...base, delta_db: null, delta_lden: null, verdict: 'holdout_withheld' }
  }
  try {
    const r = await fetch(`${SERVER}/api/noise-onfly-v2?lat=${st.lat}&lng=${st.lng}`, { signal: AbortSignal.timeout(120000) })
    if (r.status !== 200) return { ...base, delta_db: null, delta_lden: null, verdict: 'error' }
    const body = await r.json() as { total_lden: number | null; sources: Array<{ source_type: string; lden: number | null; ld: number | null; le: number | null; ln: number | null }> }
    if (!body.sources?.length || body.total_lden == null) return { ...base, delta_db: null, delta_lden: null, verdict: 'no_coverage' }
    const dominant = body.sources.filter((s) => s.lden != null).sort((a, b) => b.lden! - a.lden!)[0]
    // The snapshot's `mode` picks the comparable model quantity: airport NMTs
    // (event-classified) measure aircraft only — comparing the TOTAL there
    // would score railway noise against an aircraft mic.
    let model: Row['model']
    if (snapshot.mode === 'total') {
      // Per-period model totals: energetic sum across sources (wire carries
      // per-source ld/le/ln — the validation-v2 prerequisite).
      const totalPeriod = (k: 'ld' | 'le' | 'ln') => {
        const vals = body.sources.map((s) => s[k]).filter((v): v is number => v != null)
        return vals.length ? +(10 * Math.log10(vals.reduce((s, v) => s + 10 ** (v / 10), 0))).toFixed(1) : null
      }
      model = { lden: +body.total_lden.toFixed(1), ld: totalPeriod('ld'), le: totalPeriod('le'), ln: totalPeriod('ln') }
    } else {
      const src = body.sources.find((s) => s.source_type === snapshot.mode.replace('source:', ''))
      if (!src || src.lden == null) return { ...base, delta_db: null, delta_lden: null, verdict: 'no_coverage' }
      const r1 = (v: number | null) => (v == null ? null : +v.toFixed(1))
      model = { lden: r1(src.lden), ld: r1(src.ld), le: r1(src.le), ln: r1(src.ln) }
    }
    const measuredValue = measured[snapshot.measured_metric_field]
    const modelValue = model[snapshot.model_metric_field]
    if (modelValue == null) return { ...base, model, measured_value: measuredValue, delta_db: null, delta_lden: null, verdict: 'no_coverage' }
    const result = classifyComparison(snapshot.comparison_mode, toleranceDb, measuredValue, modelValue)
    const deltaLden = snapshot.measured_metric_field === 'lden' && snapshot.model_metric_field === 'lden'
      ? result.delta_db : null
    return {
      ...base, model, measured_value: measuredValue, model_value: modelValue,
      dominant_source: dominant?.source_type ?? null,
      delta_db: result.delta_db, delta_lden: deltaLden, verdict: result.verdict,
    }
  } catch {
    return { ...base, delta_db: null, delta_lden: null, verdict: 'error' }
  }
}

const rows: Row[] = new Array(snapshot.stations.length)
let next = 0
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < snapshot.stations.length) {
    const i = next++
    rows[i] = await queryStation(snapshot.stations[i])
    if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${snapshot.stations.length}`)
  }
}))

try {
  const serverIdentityAfter = await fetchServerIdentity(SERVER)
  assertServerIdentityStable(serverIdentityBefore, serverIdentityAfter)
} catch (error) {
  console.error(`[delta] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

const out: string[] = []
const comparisonLabel = trendOnly
  ? 'TREND ONLY: no commensurable absolute Δ'
  : snapshot.comparison_mode === 'upper_bound'
    ? `UPPER BOUND: model ≤ measured + ${toleranceDb} dB`
    : `TWO SIDED: tolerance ±${toleranceDb} dB`
out.push('')
out.push(`Δ table — ${snapshot.network} ${snapshot.year} vs ${SERVER} (${comparisonLabel})`)
out.push(`holdout policy — ${EVALUATE_HOLDOUT ? 'explicit evaluation enabled' : 'withhold future holdout model values (use --evaluate-holdout intentionally)'}`)
out.push(`${'station'.padEnd(10)} ${'name'.padEnd(34)} ${snapshot.measured_metric_field.padStart(14)} ${snapshot.model_metric_field.padStart(12)} ${'Δdb'.padStart(6)}  ${'verdict'.padEnd(15)} dominant  font`)
for (const r of rows) {
  out.push(`${r.station_id.padEnd(10)} ${r.name.slice(0, 34).padEnd(34)} ${(r.measured_value == null ? '—' : r.measured_value.toFixed(1)).padStart(14)} ${(r.model_value == null ? '—' : r.model_value.toFixed(1)).padStart(12)} ${(r.delta_db == null ? '—' : (r.delta_db >= 0 ? '+' : '') + r.delta_db.toFixed(1)).padStart(6)}  ${r.verdict.padEnd(15)} ${(r.dominant_source ?? '—').padEnd(9)} ${r.font ?? ''}`)
}
const counts: Record<string, number> = {}
for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1
const actionNote = snapshot.comparison_mode === 'upper_bound'
  ? 'above = model exceeds the measured upper bound; below is unattributable'
  : snapshot.comparison_mode === 'two_sided'
    ? 'above/below = model lies outside the two-sided tolerance'
    : 'trend-only values never produce an absolute error verdict'
out.push(`summary: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('  ')}   (${actionNote})`)
console.log(out.join('\n'))

const deltaDir = EVALUATE_HOLDOUT
  ? resolve(VALIDATION_DATA_DIR, 'holdout-evaluations/deltas')
  : resolve(VALIDATION_DATA_DIR, 'deltas')
mkdirSync(deltaDir, { recursive: true })
const outPath = resolve(deltaDir, `${snapshot.network}.${snapshot.year}.json`)
const artifact = {
  schema_version: 1,
  network: snapshot.network, year: snapshot.year, server: SERVER,
  server_identity: serverIdentityBefore,
  snapshot_sha256: snapshotSha256,
  holdout_manifest_sha256: holdoutManifestSha256,
  generated_at: new Date().toISOString(),
  comparison_mode: snapshot.comparison_mode,
  comparison_tolerance_db: snapshot.comparison_tolerance_db,
  comparison_tolerance_basis: snapshot.comparison_tolerance_basis,
  measured_metric_field: snapshot.measured_metric_field,
  model_metric_field: snapshot.model_metric_field,
  evaluate_holdout: EVALUATE_HOLDOUT,
  // Compatibility for the current validation map; consumers should migrate
  // to comparison_mode rather than infer semantics from this boolean.
  trend_only: trendOnly,
  rows,
}
const temporary = `${outPath}.tmp-${process.pid}`
try {
  writeFileSync(temporary, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' })
  renameSync(temporary, outPath)
} finally {
  rmSync(temporary, { force: true })
}
console.error(`[delta] → ${outPath}`)
