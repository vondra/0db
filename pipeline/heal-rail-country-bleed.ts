//! Generic country-bleed heal — the write-side twin of the invariant
//! auditor's R9 rule: a NATIONAL rail source id must not own rows outside its
//! own country. Registry-driven (key prefix `cc-` → country gate), so it
//! heals every national feed's residue in ONE pass — including stamps left
//! outside the stamping enricher's own bbox scope (the reason per-enricher
//! retract sweeps can't be complete: PL_BBOX starts at 14°E but legacy PL
//! stamps sit in West Bohemia; #26C).
//!
//! Disowns via writeRailTrains retract (own rows only, service rows auto-heal,
//! priority machinery untouched). The freed rows are claimed by the local
//! country's enricher on its next run (CZPTT / timetable-silent for CZ).
//!
//! Usage:
//!   DATA_YEAR=2026 npx tsx pipeline/heal-rail-country-bleed.ts --bbox S,W,N,E
//!   DATA_YEAR=2026 npx tsx pipeline/heal-rail-country-bleed.ts --world

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'
import { SOURCES } from './lib/sources.js'
import { makeCountryGate } from './lib/country-polygon.js'
import { writeRailTrains } from './lib/railways-arrow.js'
import { inBbox } from './lib/spatial.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

/** National rail sources: key `cc-…`, layer railways, measured/proxy tiers.
 *  The continental/global aggregates (eu-, europe-, global-) have no single
 *  country and are excluded by the 2-letter-prefix rule. */
function nationalRailSources(): Array<{ id: number; iso: string; key: string }> {
  const out: Array<{ id: number; iso: string; key: string }> = []
  for (const s of SOURCES) {
    if (s.layer !== 'railways') continue
    const m = /^([a-z]{2})-/.exec(s.key)
    if (!m) continue
    out.push({ id: s.id, iso: m[1].toUpperCase(), key: s.key })
  }
  return out
}

async function main() {
  const world = process.argv.includes('--world')
  const bboxArg = process.argv.includes('--bbox') ? process.argv[process.argv.indexOf('--bbox') + 1] : ''
  const BBOX = bboxArg ? (bboxArg.split(',').map(Number) as [number, number, number, number]) : null
  if (!world && (!BBOX || BBOX.length !== 4 || BBOX.some((x) => !Number.isFinite(x)))) {
    console.error('Usage: heal-rail-country-bleed.ts --bbox S,W,N,E | --world')
    process.exit(1)
  }

  const sources = nationalRailSources()
  const gates = new Map<string, (lat: number, lon: number) => boolean>()
  const gateFor = (iso: string) => {
    let g = gates.get(iso)
    if (!g) {
      g = makeCountryGate(iso)
      gates.set(iso, g)
    }
    return g
  }
  const byId = new Map(sources.map((s) => [s.id, s]))
  console.log(`country-bleed heal: ${sources.length} national rail sources, scope ${world ? 'WORLD' : BBOX!.join(',')}`)

  let hexesTouched = 0
  let totalRetracted = 0
  const perSource = new Map<string, number>()

  const hexes = readdirSync(H3R4_DIR).filter((d) => d.length === 15 && d.endsWith('ffffffff'))
  for (const hex of hexes) {
    if (!world) {
      try {
        const [lat, lon] = cellToLatLng(hex)
        if (!inBbox(lat, lon, BBOX!)) continue
      } catch {
        continue
      }
    }
    const path = resolve(H3R4_DIR, hex, 'railways.arrow')
    if (!existsSync(path)) continue

    // Cheap read-only probe first: which national ids own rows here at all?
    const t = tableFromIPC(readFileSync(path))
    const srcCol = t.getChild('source_id')
    if (!srcCol) continue
    const present = new Set<number>()
    for (let i = 0; i < t.numRows; i++) {
      const v = srcCol.get(i) as number
      if (v && byId.has(v)) present.add(v)
    }
    if (present.size === 0) continue

    let hexHit = false
    for (const id of present) {
      const s = byId.get(id)!
      const inCountry = gateFor(s.iso)
      const r = await writeRailTrains(path, () => null, undefined, {
        sourceId: id,
        when: (row) => !inCountry(row.midLat, row.midLon),
      })
      if (r.retracted > 0) {
        totalRetracted += r.retracted
        perSource.set(s.key, (perSource.get(s.key) ?? 0) + r.retracted)
        hexHit = true
      }
    }
    if (hexHit) hexesTouched++
  }

  console.log(`\n=== country-bleed heal done ===`)
  console.log(`  ${totalRetracted.toLocaleString()} foreign rows disowned across ${hexesTouched} hexes`)
  for (const [key, n] of [...perSource].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${key}: ${n.toLocaleString()}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })
}
