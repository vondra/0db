/**
 * READ-ONLY enrichment-invariant scanner (A3/C2 of the 2026-06 audit wave) —
 * the acceptance gate after every reset + re-enrich (see migrations/README.md).
 *
 * Capability-aware per the /gg W5 verdict: instead of hardcoding "class>=5 +
 * national source = violation", each rule reads the source's declared
 * capability (`roadCoverage` / `railFamilies`) from `lib/enrichment-datasets.ts`
 * and skips rows whose source declares none — no guessing about undeclared feeds.
 *
 * Rules:
 *   R1 road-coverage   — row's road_class outside its source's declared roadCoverage
 *   R2 moto-scramble   — aadt_moto > max(500, 0.5*aadt_light): cars landed in the
 *                        moto column (the PL provincial XLS column-shift bug shape)
 *   R3 tram-overcount  — tram/light_rail row with trains_passenger > 400 from a
 *                        source whose railFamilies excludes 'tram' (family defaults
 *                        are <=250, so 400 clears them with margin)
 *   R4 wind-as-thermal — industrial row whose name matches the wind keyword set
 *                        AND nace_4digit in {3500,3511,3512} (wind is source_type=10,
 *                        never a power NACE — the pre-5f1b969f bug shape)
 *
 * Usage:
 *   DATA_YEAR=2026 npx tsx pipeline/audit-enrichment-invariants.ts --bbox S,W,N,E [--sample N]
 *
 * `--sample N` checks at most ~N evenly-strided rows per hex per layer.
 * Exits non-zero when violations are found (prints a table, first 50 rows).
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableFromIPC, type Table, type Vector } from 'apache-arrow'
import { DATASETS } from './lib/enrichment-datasets.js'
import { iterateCountryHexes } from './lib/roads-arrow.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const YEAR = process.env.DATA_YEAR || readFileSync(resolve(__dirname, '..', 'DATA_YEAR'), 'utf8').trim()
const H3R4_DIR = resolve(__dirname, '..', 'data', 'prepared', YEAR, 'h3r4')

// Wind keyword set — copied from NAME_RULES 'wind (skip)' in
// enrich-industrial-name-heuristic.ts (not importable: that file runs main() on
// import). Substring match on the lowercased name, same as its matchName().
const WIND_NAME_KEYWORDS = [
  'wind farm', 'wind park', 'windpark', 'éolien', 'vindpark', 'vindkraft',
  'parque eólico', 'větrná', 'wiatrowy',
]
const POWER_NACE = new Set([3500, 3511, 3512])

// ── args ─────────────────────────────────────────────────────────────────────

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

const bboxArg = arg('--bbox')
if (!bboxArg) {
  console.error('Usage: npx tsx pipeline/audit-enrichment-invariants.ts --bbox S,W,N,E [--sample N]')
  process.exit(2)
}
const [s, w, n, e] = bboxArg.split(',').map(Number)
if (![s, w, n, e].every(Number.isFinite) || s >= n || w >= e) {
  console.error(`Invalid --bbox '${bboxArg}' — expected S,W,N,E with S<N and W<E`)
  process.exit(2)
}
const BBOX: [number, number, number, number] = [s, w, n, e] // [minLat, minLon, maxLat, maxLon]
const SAMPLE = arg('--sample') ? Math.max(1, parseInt(arg('--sample')!, 10)) : Infinity

// ── capability registry ──────────────────────────────────────────────────────

const ROAD_COVERAGE = new Map<number, ReadonlySet<number>>()
const RAIL_FAMILIES = new Map<number, ReadonlySet<string>>()
const KEY_BY_ID = new Map<number, string>()
const HIGH_MOTO = new Set<number>()
for (const d of DATASETS) {
  KEY_BY_ID.set(d.id, d.key)
  if (d.roadCoverage) ROAD_COVERAGE.set(d.id, new Set(d.roadCoverage))
  if (d.railFamilies) RAIL_FAMILIES.set(d.id, new Set(d.railFamilies))
  if (d.highMoto) HIGH_MOTO.add(d.id)
}

// ── violation collection ─────────────────────────────────────────────────────

interface Violation {
  rule: string
  hex: string
  row: number
  source: string
  lat: number
  lon: number
  detail: string
}
const violations: Violation[] = []
const byRule = new Map<string, number>()

function report(rule: string, hex: string, row: number, sourceId: number, lat: number, lon: number, detail: string): void {
  byRule.set(rule, (byRule.get(rule) ?? 0) + 1)
  violations.push({ rule, hex, row, source: KEY_BY_ID.get(sourceId) ?? `id ${sourceId}`, lat, lon, detail })
}

// ── scan plumbing ────────────────────────────────────────────────────────────

/** Evenly-strided row indices: every row when n<=SAMPLE, else ~SAMPLE of them. */
function* sampleRows(numRows: number): Generator<number> {
  const stride = numRows > SAMPLE ? Math.ceil(numRows / SAMPLE) : 1
  for (let i = 0; i < numRows; i += stride) yield i
}

function scanLayer(
  layerFile: string,
  checkTable: (t: Table, hex: string) => number,
): { hexes: number; rows: number; ms: number } {
  const t0 = Date.now()
  const hexes = iterateCountryHexes(H3R4_DIR, BBOX, layerFile)
  let rows = 0
  for (const hex of hexes) {
    let table: Table
    try { table = tableFromIPC(readFileSync(resolve(H3R4_DIR, hex, layerFile))) } catch { continue }
    rows += checkTable(table, hex)
  }
  return { hexes: hexes.length, rows, ms: Date.now() - t0 }
}

/** Segment midpoint (lat, lon) for row `i`, falling back to the start vertex
 *  when the end column is absent — used only to label a violation's location. */
function segMid(
  sLat: Vector, sLon: Vector, eLat: Vector | null, eLon: Vector | null, i: number,
): [number, number] {
  const s0 = sLat.get(i) as number, s1 = sLon.get(i) as number
  const e0 = (eLat?.get(i) as number) ?? s0, e1 = (eLon?.get(i) as number) ?? s1
  return [(s0 + e0) / 2, (s1 + e1) / 2]
}

// ── R1 + R2: roads ───────────────────────────────────────────────────────────

const roads = scanLayer('roads.arrow', (t, hex) => {
  const cls = t.getChild('road_class')
  const light = t.getChild('aadt_light')
  const moto = t.getChild('aadt_moto')
  const src = t.getChild('source_id')
  const sLat = t.getChild('start_lat'), sLon = t.getChild('start_lon')
  const eLat = t.getChild('end_lat'), eLon = t.getChild('end_lon')
  if (!cls || !light || !moto || !src || !sLat || !sLon) return 0
  let checked = 0
  for (const i of sampleRows(t.numRows)) {
    checked++
    const id = (src.get(i) as number) ?? 0
    const c = (cls.get(i) as number) ?? 0
    const li = (light.get(i) as number) ?? 0
    const mo = (moto.get(i) as number) ?? 0
    const [la, lo] = segMid(sLat, sLon, eLat, eLon, i)
    if (id > 0 && !KEY_BY_ID.has(id)) {
      report('R0 unknown-source', hex, i, id, la, lo, `source_id=${id} not in DATASETS registry`)
    }
    const coverage = ROAD_COVERAGE.get(id)
    if (coverage && !coverage.has(c)) {
      report('R1 road-coverage', hex, i, id, la, lo, `road_class=${c} outside declared coverage`)
    }
    if (li > 0 && mo > Math.max(500, 0.5 * li) && !HIGH_MOTO.has(id)) {
      report('R2 moto-scramble', hex, i, id, la, lo, `aadt_moto=${mo} vs aadt_light=${li}`)
    }
  }
  return checked
})

// ── R3: railways ─────────────────────────────────────────────────────────────

const rails = scanLayer('railways.arrow', (t, hex) => {
  const rt = t.getChild('rail_type')
  const pax = t.getChild('trains_passenger')
  const src = t.getChild('source_id')
  const sLat = t.getChild('start_lat'), sLon = t.getChild('start_lon')
  const eLat = t.getChild('end_lat'), eLon = t.getChild('end_lon')
  if (!rt || !pax || !src || !sLat || !sLon) return 0
  let checked = 0
  for (const i of sampleRows(t.numRows)) {
    checked++
    const id = (src.get(i) as number) ?? 0
    const type = (rt.get(i) as number) ?? 0
    const p = (pax.get(i) as number) ?? 0
    if (type !== 1 && type !== 2) continue
    if (p <= 400) continue
    const families = RAIL_FAMILIES.get(id)
    if (families && !families.has('tram')) {
      const [la, lo] = segMid(sLat, sLon, eLat, eLon, i)
      report('R3 tram-overcount', hex, i, id, la, lo, `rail_type=${type} trains_passenger=${p} from non-tram source`)
    }
  }
  return checked
})

// ── R4: industrial ───────────────────────────────────────────────────────────

const industrial = scanLayer('industrial.arrow', (t, hex) => {
  const name = t.getChild('name')
  const nace = t.getChild('nace_4digit')
  const src = t.getChild('source_id')
  const lat = t.getChild('centroid_lat'), lon = t.getChild('centroid_lon')
  if (!name || !nace || !src || !lat || !lon) return 0
  let checked = 0
  for (const i of sampleRows(t.numRows)) {
    checked++
    const nc = (nace.get(i) as number) ?? 0
    if (!POWER_NACE.has(nc)) continue
    const nm = (name.get(i) as string | null) ?? ''
    if (!nm) continue
    const lower = nm.toLowerCase()
    if (WIND_NAME_KEYWORDS.some(kw => lower.includes(kw))) {
      report('R4 wind-as-thermal', hex, i, (src.get(i) as number) ?? 0,
        lat.get(i) as number, lon.get(i) as number, `nace=${nc} name="${nm.slice(0, 50)}"`)
    }
  }
  return checked
})

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`=== Enrichment invariant scan — bbox ${BBOX.join(',')} (${YEAR}) ===`)
if (SAMPLE !== Infinity) console.log(`  sampling: ~${SAMPLE} rows per hex per layer`)
console.log(`  roads      ${roads.hexes} hexes  ${roads.rows.toLocaleString()} rows checked  ${(roads.ms / 1000).toFixed(1)}s`)
console.log(`  railways   ${rails.hexes} hexes  ${rails.rows.toLocaleString()} rows checked  ${(rails.ms / 1000).toFixed(1)}s`)
console.log(`  industrial ${industrial.hexes} hexes  ${industrial.rows.toLocaleString()} rows checked  ${(industrial.ms / 1000).toFixed(1)}s`)

if (violations.length === 0) {
  console.log(`\nCLEAN — no invariant violations.`)
  process.exit(0)
}

console.log(`\n${violations.length} VIOLATION(S):`)
for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule}: ${count}`)
}
console.log(`\n  ${'rule'.padEnd(18)} ${'source'.padEnd(22)} ${'hex'.padEnd(16)} ${'row'.padStart(7)}  ${'lat'.padStart(8)} ${'lon'.padStart(9)}  detail`)
for (const v of violations.slice(0, 50)) {
  console.log(`  ${v.rule.padEnd(18)} ${v.source.padEnd(22)} ${v.hex.padEnd(16)} ${String(v.row).padStart(7)}  ${v.lat.toFixed(4).padStart(8)} ${v.lon.toFixed(4).padStart(9)}  ${v.detail}`)
}
if (violations.length > 50) console.log(`  … and ${violations.length - 50} more`)
process.exit(1)
