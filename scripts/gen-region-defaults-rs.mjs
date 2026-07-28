#!/usr/bin/env node
// Generate engine/noise-compute/src/region_defaults_generated.rs — the
// MEASURED country × road_class default arm (M6.3 regional calibration),
// computed from national traffic censuses only. Numbers come from data,
// never estimated: per (country, class) the table carries the MEDIAN
// measured per-section AADT × the MEDIAN measured class shares.
//
// Cascade position (defaults.rs): BELOW city, ABOVE the hand-tuned country
// arms. A country whose census feeds this table has its hand-tuned arm
// DELETED (values superseded by measured ones) — tonight that is TH only:
// the BR arm stays because no BR per-section measured data is wired into
// the pipeline yet (the DNIT-derived BR table is corridor-level, not
// per-section counts).
//
// Source-generic on purpose: CENSUSES is a list of adapters, one per
// country's measured census. Each adapter yields normalized rows
// { engineClass, total, light, medium, heavy, moto } — the median math and
// the Rust emission are shared. To plug in the next country (DE BASt, CZ
// ŘSD, …), add an adapter that reads its cached census and maps its road
// classes onto engine classes; nothing else changes.
//
// TH adapter — DRR 2024 rural-road census (กรมทางหลวงชนบท, MOT CKAN mirror,
// same cache file as pipeline/enrich-roads-th.ts):
//   road_code numbers 1000–5999 (major rural collectors) → engine class 3
//   road_code numbers 6000–7999 (minor rural roads)      → engine class 4
//   ส.0xx Bangkok bridges (num < 1000) are excluded — not rural roads.
// The mapping mirrors the name matcher's class gate (enrich-roads-th-names.ts).
// The census speaks only for rural secondary/tertiary — classes 0/1/2/5
// have no per-section measurements tonight and stay with the GDP-scale /
// WORLD arms below.
//
// Usage:
//   node scripts/gen-region-defaults-rs.mjs
// Commit the generated .rs together with this script.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_YEAR = process.env.DATA_YEAR || '2026'
const OUTPUT = resolve(ROOT, 'engine', 'noise-compute', 'src', 'region_defaults_generated.rs')

const MIN_ROWS_PER_BUCKET = 30 // below this a median is anecdote, not calibration

// ── Proper CSV parse (quotes, escaped quotes, embedded newlines) ─────────
// The DRR file wraps 12 road_names across quoted newlines; a naive
// split('\n') loader silently drops them (the legacy ref enricher does).

function parseCsv(text) {
  const records = []
  let field = ''
  let record = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { record.push(field); field = '' }
    else if (c === '\n') { record.push(field); field = ''; if (record.length > 1) records.push(record); record = [] }
    else if (c !== '\r') field += c
  }
  if (field || record.length) { record.push(field); if (record.length > 1) records.push(record) }
  const headers = records[0]
  return records.slice(1).map(rec => Object.fromEntries(headers.map((h, i) => [h, rec[i] ?? ''])))
}

// ── Median helpers ───────────────────────────────────────────────────────

function median(values) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ── TH adapter: DRR 2024 rural roads ─────────────────────────────────────

function loadThDrr() {
  const path = resolve(ROOT, 'data', 'enrichment', DATA_YEAR, 'th', 'drr-aadt-2024.csv')
  if (!existsSync(path)) throw new Error(`TH DRR census cache missing: ${path} (run pipeline/enrich-roads-th.ts once)`)
  const records = parseCsv(readFileSync(path, 'utf-8'))
  const rows = []
  let skippedNoSplit = 0
  let skippedClass = 0
  for (const r of records) {
    const code = (r.road_code || '').trim()
    const dot = code.lastIndexOf('.')
    if (dot <= 0) continue
    const num = parseInt(code.slice(dot + 1), 10)
    if (!Number.isInteger(num)) continue
    let engineClass
    if (num >= 1000 && num <= 5999) engineClass = 3
    else if (num >= 6000 && num <= 7999) engineClass = 4
    else { skippedClass++; continue } // ส.0xx Bangkok bridges etc.
    const total = parseFloat(r.sum_AADT || '0')
    if (!isFinite(total) || total <= 0) continue
    const n = k => parseFloat(r[k] || '0') || 0
    // CNOSSOS split — mirrors pipeline/enrich-roads-th.ts::drrToCnossos.
    const light = n('SV') + n('SVT')
    const medium = n('TB2') + n('BD') + n('DRT')
    const heavy = n('TB3') + n('T4') + n('ART3') + n('ART4') + n('ART5') + n('ART6')
    const moto = n('MC')
    if (light + medium + heavy + moto === 0) { skippedNoSplit++; continue }
    rows.push({ engineClass, total, light, medium, heavy, moto })
  }
  return { rows, skippedNoSplit, skippedClass, censusFile: path }
}

const CENSUSES = [
  // TH DRR 2024 is PARKED (/gg M6 Codex 2026-07-28): its number-band →
  // engine-class crosswalk proved invalid — 1xxx–5xxx sections are
  // dominantly engine class 4, not 3, so band medians biased class-3 roads
  // ~4.6 dB low (hand-tuned arm was closer). Re-enable after class
  // attribution via exact-ref joins (dominant OSM class per census code),
  // not administrative bands. The TH hand-tuned arm in defaults.rs carries
  // TH until then.
  // {
  //   iso: 'TH',
  //   name: 'DRR Rural Roads AADT 2024 (กรมทางหลวงชนบท, MOT CKAN mirror)',
  //   url: 'https://datagov.mot.go.th/datastore/dump/d0675c68-510b-45e1-b865-1ce261814948?format=csv',
  //   load: loadThDrr,
  // },
]

// ── Compute per (iso, class) ─────────────────────────────────────────────

const entries = [] // { iso, class, n, total, light, medium, heavy, moto, shares }
for (const census of CENSUSES) {
  const { rows, skippedNoSplit, skippedClass, censusFile } = census.load()
  const byClass = new Map()
  for (const r of rows) {
    if (!byClass.has(r.engineClass)) byClass.set(r.engineClass, [])
    byClass.get(r.engineClass).push(r)
  }
  for (const [engineClass, group] of [...byClass.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length < MIN_ROWS_PER_BUCKET) {
      console.log(`  ${census.iso} class ${engineClass}: SKIPPED — only ${group.length} rows (< ${MIN_ROWS_PER_BUCKET})`)
      continue
    }
    const medTotal = median(group.map(r => r.total))
    const medShares = ['light', 'medium', 'heavy', 'moto'].map(k => median(group.map(r => r[k] / r.total)))
    const shareSum = medShares.reduce((a, b) => a + b, 0)
    // Renormalize shares so the tuple sums exactly to the median total.
    const [light, medium, heavy, moto] = medShares.map(s => Math.round(((medTotal * s) / shareSum) * 10) / 10)
    entries.push({
      iso: census.iso,
      class: engineClass,
      n: group.length,
      total: medTotal,
      light, medium, heavy, moto,
      shares: medShares,
      source: census.name,
      url: census.url,
    })
    console.log(
      `  ${census.iso} class ${engineClass}: n=${group.length} median AADT=${medTotal.toFixed(0)} ` +
      `median shares L/M/H/Mo=${medShares.map(s => (s * 100).toFixed(1) + '%').join('/')} ` +
      `→ tuple (${light}, ${medium}, ${heavy}, ${moto})`,
    )
  }
  console.log(`  (${census.iso}: ${rows.length} census rows used from ${censusFile}; ${skippedNoSplit} no-split, ${skippedClass} non-rural codes skipped)`)
}

// An empty CENSUSES list (all adapters parked) emits an empty table — the
// cascade arm then never fires and the hand-tuned arms carry everything.
// Throw only when an adapter is present but yields nothing (a data bug).
if (CENSUSES.length > 0 && entries.length === 0) throw new Error('no census entries produced — refusing to emit an empty table')
// binary_search_by in the consumer requires the table sorted by (iso, class)
// — enforce it here; a new census adapter inserted out of order must never
// silently break every lookup (/gg M6 #4).
entries.sort((a, b) => a.iso.localeCompare(b.iso) || a.class - b.class)

// ── Emit Rust ────────────────────────────────────────────────────────────

const out = []
out.push(`//! MEASURED country × road_class traffic defaults (M6.3 regional
//! calibration). Generated by \`scripts/gen-region-defaults-rs.mjs\` from
//! national traffic censuses — every number is the MEDIAN of measured
//! per-section counts, never estimated:
//!`)
for (const census of CENSUSES) {
  out.push(`//!   ${census.iso}: ${census.name}`)
}
out.push(`//!
//! Cascade position (\`defaults.rs::country_default\`): BELOW city arms,
//! ABOVE the hand-tuned country arms. A country present here has its
//! hand-tuned arm deleted (superseded by measured data). Classes a census
//! does not cover stay absent here and fall through to the hand-tuned /
//! GDP-scale arms below — the table claims only what the data measured.
//!
//! Refresh: \`node scripts/gen-region-defaults-rs.mjs\` (commit this file
//! with the script change; the census CSV cache is a pipeline artifact).`)
out.push('')
out.push('use crate::defaults::Aadt;')
out.push('')
out.push('/// (iso, engine road_class, (light, medium, heavy, moto)) — veh/day both')
out.push('/// directions. Sorted by (iso, class) for binary search.')
out.push('pub const REGION_DEFAULTS: &[(&[u8; 2], u8, Aadt)] = &[')
for (const e of entries) {
  out.push(
    `    (b"${e.iso}", ${e.class}, (${e.light.toFixed(1)}, ${e.medium.toFixed(1)}, ${e.heavy.toFixed(1)}, ${e.moto.toFixed(1)})), // n=${e.n} sections, median AADT ${e.total.toFixed(0)} — ${e.source}`,
  )
}
out.push('];')
out.push('')
out.push('/// Measured default for (country, road_class), or None when no census')
out.push('/// covers that arm — the caller then falls through to the hand-tuned')
out.push('/// country arms and the GDP-scale fallback.')
out.push('pub fn region_default(iso: &[u8; 2], class: u8) -> Option<Aadt> {')
out.push('    REGION_DEFAULTS')
out.push('        .binary_search_by(|(i, c, _)| (**i, *c).cmp(&(*iso, class)))')
out.push('        .ok()')
out.push('        .map(|idx| REGION_DEFAULTS[idx].2)')
out.push('}')

writeFileSync(OUTPUT, out.join('\n') + '\n')
console.log(`\nWrote ${OUTPUT} (${entries.length} arms)`)
