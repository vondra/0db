/**
 * Calibrate lane-based AADT scaling ratios from enriched census data.
 *
 * Reads all enriched roads.arrow (traffic_source=1), deduplicates by census
 * section, computes MEDIAN total AADT per (road_class × lanes × oneway) bucket,
 * and outputs ratio table relative to 2-lane baseline.
 *
 * Output: ratio table as JSON + Rust const for pipeline-worker.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/calibrate-lane-ratios.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

const CLASS_NAMES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_st']

// Baseline: 2-lane oneway for motorway/trunk, 2-lane twoway for primary-tertiary
const BASELINE_SPEC: Record<number, { lanes: number; oneway: boolean }> = {
  0: { lanes: 2, oneway: true },   // motorway
  1: { lanes: 2, oneway: true },   // trunk
  2: { lanes: 2, oneway: false },  // primary
  3: { lanes: 2, oneway: false },  // secondary
  4: { lanes: 2, oneway: false },  // tertiary
}

interface CensusSection {
  roadClass: number
  lanes: number
  oneway: boolean
  totalAADT: number
  ref: string
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function main(): void {
  console.log(`=== Calibrate Lane Ratios (${YEAR}) ===\n`)

  // Step 1: Collect all enriched road segments
  const sections: CensusSection[] = []
  const seen = new Set<string>() // deduplication key

  const hexDirs = readdirSync(H3R4_DIR).filter(d => d.endsWith('ffffffff'))

  for (const hex of hexDirs) {
    const p = resolve(H3R4_DIR, hex, 'roads.arrow')
    if (!existsSync(p)) continue
    const t = tableFromIPC(readFileSync(p))

    const rc = t.getChild('road_class')
    const ln = t.getChild('lanes')
    const ow = t.getChild('oneway')
    const ts = t.getChild('traffic_source')
    const al = t.getChild('aadt_light')
    const am = t.getChild('aadt_medium')
    const ah = t.getChild('aadt_heavy')
    const mo = t.getChild('aadt_moto')
    const ref = t.getChild('ref')
    if (!rc || !ts || !al) continue

    for (let i = 0; i < t.numRows; i++) {
      if (!ts || ts.get(i) !== 1) continue
      if (!al || al.get(i) <= 0) continue

      const roadClass = rc.get(i) as number
      if (roadClass >= 5) continue // skip residential, living_street

      const lanes = ln ? (ln.get(i) as number) : 0
      const oneway = ow ? (ow.get(i) as boolean) : false
      const total = (al.get(i) || 0) + (am ? am.get(i) || 0 : 0) + (ah ? ah.get(i) || 0 : 0) + (mo ? mo.get(i) || 0 : 0)
      const roadRef = ref ? (ref.get(i) as string | null) || '' : ''

      // Deduplicate by census section: same ref + same class + similar AADT = same section
      // Round AADT to nearest 100 to group segments from same census section
      const dedup = `${roadClass}_${roadRef}_${Math.round(total / 100)}`
      if (seen.has(dedup)) continue
      seen.add(dedup)

      // Skip lanes=0 for ratio computation (unknown, not physical)
      if (lanes === 0) continue

      sections.push({ roadClass, lanes: Math.min(lanes, 6), oneway, totalAADT: total, ref: roadRef })
    }
  }

  console.log(`  Unique census sections (deduplicated): ${sections.length}`)
  console.log()

  // Step 2: Compute baselines (median AADT for 2-lane spec per class)
  const baselines: Record<number, number> = {}
  for (const [cls, spec] of Object.entries(BASELINE_SPEC)) {
    const clsNum = parseInt(cls)
    const matching = sections.filter(s =>
      s.roadClass === clsNum && s.lanes === spec.lanes && s.oneway === spec.oneway)
    const med = median(matching.map(s => s.totalAADT))
    baselines[clsNum] = med
    console.log(`  Baseline ${CLASS_NAMES[clsNum]} (${spec.lanes}L ${spec.oneway ? 'OW' : 'TW'}): median ${Math.round(med)} AADT (N=${matching.length})`)
  }
  console.log()

  // Step 3: Compute ratios per bucket
  type BucketKey = string
  const buckets = new Map<BucketKey, number[]>()

  for (const s of sections) {
    const key = `${s.roadClass}_${s.lanes}_${s.oneway ? 'ow' : 'tw'}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(s.totalAADT)
  }

  console.log('  Road class      Lanes  Dir    N_sections  Median AADT    Ratio')
  console.log('  ' + '─'.repeat(70))

  const ratioTable: Record<string, { ratio: number; n: number; medianAADT: number }> = {}

  for (const [key, values] of [...buckets.entries()].sort()) {
    const [clsStr, lanesStr, dir] = key.split('_')
    const cls = parseInt(clsStr)
    const lanes = parseInt(lanesStr)
    const n = values.length
    if (n < 30) continue // not enough data

    const med = median(values)
    const baseline = baselines[cls]
    const ratio = baseline ? med / baseline : 1.0

    ratioTable[key] = { ratio: Math.round(ratio * 100) / 100, n, medianAADT: Math.round(med) }

    const name = CLASS_NAMES[cls] || '?'
    console.log(
      `  ${name.padEnd(16)} ${String(lanes).padStart(3)}    ${dir.padEnd(4)} ${String(n).padStart(8)}  ${String(Math.round(med)).padStart(12)}    ${ratio.toFixed(2).padStart(6)}`
    )
  }

  // Step 4: Output as Rust const
  console.log('\n\n// ── Rust const for pipeline-worker ──')
  console.log('fn lane_ratio(class_idx: usize, lanes: u8, oneway: bool) -> f64 {')
  console.log('    if lanes <= 2 { return 1.0; }')
  console.log('    match (class_idx, oneway) {')

  for (let cls = 0; cls <= 4; cls++) {
    for (const ow of [true, false]) {
      const entries: { lanes: number; ratio: number }[] = []
      for (let l = 3; l <= 6; l++) {
        const key = `${cls}_${l}_${ow ? 'ow' : 'tw'}`
        const entry = ratioTable[key]
        if (entry) entries.push({ lanes: l, ratio: entry.ratio })
      }
      if (entries.length === 0) continue

      const maxL = Math.max(...entries.map(e => e.lanes))
      const dir = ow ? 'true ' : 'false'
      const name = CLASS_NAMES[cls]
      const arms = entries.map(e => `${e.lanes} => ${e.ratio.toFixed(2)}`).join(', ')
      console.log(`        (${cls}, ${dir}) => match lanes.min(${maxL}) { ${arms}, _ => 1.0 }, // ${name} ${ow ? 'OW' : 'TW'}`)
    }
  }

  console.log('        _ => 1.0,')
  console.log('    }')
  console.log('}')

  // Step 5: JSON output
  console.log('\n// JSON:')
  console.log(JSON.stringify(ratioTable, null, 2))
}

main()
