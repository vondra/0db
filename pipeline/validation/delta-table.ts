/**
 * Leg A Δ table: model vs a committed network snapshot
 * (benchmarks/validation/snapshots/{network}.{year}.json). Queries the popup
 * (noise-onfly-v2) at every snapshot station — ≤2 concurrent, read-only —
 * and writes data/validation/deltas/{network}.{year}.json plus a console
 * table. Regenerated per snapshot; consumed by the uncertainty table later.
 *
 * Commensurability drives the comparison, never the other way round:
 *  - period_split + total_ambient (Barcelona): Δ = model total_lden −
 *    measured lden per END period too; the ASYMMETRIC rule applies — only
 *    model > measured + U is a gap (model_total ≤ measured + U); model below
 *    ambient is unattributable, not model error. Composition column shows the
 *    dominant modelled source next to the station's Font tag.
 *  - laeq_windows (ZRH): different window, no honest Δ — both series are
 *    reported side by side as a TREND anchor (trend_only: true).
 *
 * Run: npx tsx pipeline/validation/delta-table.ts --snapshot benchmarks/validation/snapshots/barcelona-xarxa-soroll.2025.json
 *      [CHECK_WORLD_SERVER=http://localhost:8531]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { VALIDATION_DATA_DIR, type Snapshot } from './lib.ts'

const SERVER = process.env.CHECK_WORLD_SERVER || 'http://localhost:8520'
// Asymmetric-rule slack: measurement uncertainty of a street NMT annual value
// (class-1 mic + siting). Conservative 2 dB, stated in the output.
const AMBIENT_U_DB = 2.0
const CONCURRENCY = 2

const snapArg = process.argv[process.argv.indexOf('--snapshot') + 1]
if (!snapArg) {
  console.error('usage: npx tsx pipeline/validation/delta-table.ts --snapshot <benchmarks/validation/snapshots/*.json>')
  process.exit(2)
}
const snapshot = JSON.parse(readFileSync(snapArg, 'utf8')) as Snapshot
const MODES = new Set(['total', 'source:road', 'source:railway', 'source:industrial', 'source:building', 'source:aircraft'])
if (!MODES.has(snapshot.mode)) {
  console.error(`[delta] snapshot ${snapArg} has no valid \`mode\` (got ${JSON.stringify(snapshot.mode)}) — regenerate it with the current adapter`)
  process.exit(2)
}
const trendOnly = snapshot.commensurability.metric_variant === 'laeq_windows'

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
  dominant_source: string | null
  font?: string
  delta_lden: number | null
  verdict: 'above' | 'within_bound' | 'below' | 'unattributable' | 'trend_only' | 'no_coverage' | 'error'
}

async function queryStation(st: Snapshot['stations'][number]): Promise<Row> {
  const measured = {
    lden: (st.lden as number) ?? null, ld: (st.ld as number) ?? null,
    le: (st.le as number) ?? null, ln: (st.ln as number) ?? null,
    laeq_tag_0622: (st.laeq_tag_0622 as number) ?? null,
  }
  const base: Omit<Row, 'delta_lden' | 'verdict'> = {
    station_id: st.station_id, name: st.name, measured,
    model: { lden: null, ld: null, le: null, ln: null },
    dominant_source: null, font: st.font as string | undefined,
  }
  try {
    const r = await fetch(`${SERVER}/api/noise-onfly-v2?lat=${st.lat}&lng=${st.lng}`, { signal: AbortSignal.timeout(120000) })
    if (r.status !== 200) return { ...base, delta_lden: null, verdict: 'error' }
    const body = await r.json() as { total_lden: number | null; sources: Array<{ source_type: string; lden: number | null; ld: number | null; le: number | null; ln: number | null }> }
    if (!body.sources?.length || body.total_lden == null) return { ...base, delta_lden: null, verdict: 'no_coverage' }
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
      if (!src || src.lden == null) return { ...base, delta_lden: null, verdict: 'no_coverage' }
      const r1 = (v: number | null) => (v == null ? null : +v.toFixed(1))
      model = { lden: r1(src.lden), ld: r1(src.ld), le: r1(src.le), ln: r1(src.ln) }
    }
    if (trendOnly || measured.lden == null) {
      return { ...base, model, dominant_source: dominant?.source_type ?? null, delta_lden: null, verdict: 'trend_only' }
    }
    const delta = +(model.lden! - measured.lden).toFixed(1)
    // Below-band is unattributable ONLY under the asymmetric total-ambient
    // rule; for source-dominant anchors (event-classified NMTs, near-source)
    // an under-prediction is an ordinary actionable Δ.
    const totalAmbient = snapshot.commensurability.dominance === 'total_ambient'
    const verdict = delta > AMBIENT_U_DB ? 'above'
      : delta >= -AMBIENT_U_DB ? 'within_bound'
      : totalAmbient ? 'unattributable' : 'below'
    return { ...base, model, dominant_source: dominant?.source_type ?? null, delta_lden: delta, verdict }
  } catch {
    return { ...base, delta_lden: null, verdict: 'error' }
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

const out: string[] = []
out.push('')
out.push(`Δ table — ${snapshot.network} ${snapshot.year} vs ${SERVER} (${trendOnly ? 'TREND ONLY: window metric, no honest Δ' : `asymmetric total-ambient rule, U=${AMBIENT_U_DB} dB`})`)
out.push(`${'station'.padEnd(10)} ${'name'.padEnd(34)} ${'meas'.padStart(6)} ${'model'.padStart(6)} ${'Δlden'.padStart(6)}  ${'verdict'.padEnd(15)} dominant  font`)
for (const r of rows) {
  const meas = r.measured.lden ?? r.measured.laeq_tag_0622
  out.push(`${r.station_id.padEnd(10)} ${r.name.slice(0, 34).padEnd(34)} ${(meas == null ? '—' : meas.toFixed(1)).padStart(6)} ${(r.model.lden == null ? '—' : r.model.lden.toFixed(1)).padStart(6)} ${(r.delta_lden == null ? '—' : (r.delta_lden >= 0 ? '+' : '') + r.delta_lden.toFixed(1)).padStart(6)}  ${r.verdict.padEnd(15)} ${(r.dominant_source ?? '—').padEnd(9)} ${r.font ?? ''}`)
}
const counts: Record<string, number> = {}
for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1
out.push(`summary: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('  ')}   (above = model exceeds measured+U — the actionable list)`)
console.log(out.join('\n'))

mkdirSync(resolve(VALIDATION_DATA_DIR, 'deltas'), { recursive: true })
const outPath = resolve(VALIDATION_DATA_DIR, 'deltas', `${snapshot.network}.${snapshot.year}.json`)
writeFileSync(outPath, JSON.stringify({
  network: snapshot.network, year: snapshot.year, server: SERVER,
  generated_at: new Date().toISOString(), ambient_u_db: AMBIENT_U_DB, trend_only: trendOnly,
  rows,
}, null, 2) + '\n')
console.error(`[delta] → ${outPath}`)
