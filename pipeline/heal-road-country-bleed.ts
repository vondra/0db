//! Country-bleed heal for ROADS — the write-side twin of the invariant
//! auditor's R9 rule and the exact analog of heal-rail-country-bleed: a
//! NATIONAL road source id must not own rows wholly outside its own country.
//! Registry-driven (key prefix `cc-` → ownership gate), so it heals every
//! national census's residue in ONE pass — including stamps a per-enricher
//! bbox sweep can't reach.
//!
//! Roads never had a country gate before #33 (they match by ref within a
//! bbox that reaches deep into neighbours — the TR census stamped 44k rows in
//! Greece/Iran, JP 51k over Korea; world gate 2026-07-12). writeRoadAadt now
//! auto-gates the STAMP side from the source's cc- prefix; this heal clears the
//! LEGACY foreign stamps already in the arrows, running BEFORE the road
//! claimers so the freed rows are re-claimed (by the correct country, or the
//! lower-priority heuristics) in the same chain run.
//!
//! Disowns via writeRoadAadt retract (own rows only, taper cleared with the
//! row, priority machinery untouched, falls through to same-pass re-claim).
//!
//! Usage:
//!   DATA_YEAR=2026 npx tsx pipeline/heal-road-country-bleed.ts --bbox S,W,N,E
//!   DATA_YEAR=2026 npx tsx pipeline/heal-road-country-bleed.ts --world
//!   … --verify   report-only: writes NOTHING, exits 1 when the heal WOULD
//!                retract anything. The chain runs the heal BEFORE the road
//!                claimers and this verify AFTER them — a nonzero exit means a
//!                claimer re-stamped foreign rows and must itself be fixed.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'
import { SOURCES } from './lib/sources.js'
import { makeOwnershipGate, hasCountryPolygon, segmentWhollyOutside } from './lib/country-polygon.js'
import { writeRoadAadt } from './lib/roads-arrow.js'
import { inBbox } from './lib/spatial.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

/** National road sources: provenance tier `national-*`, layer roads, country
 *  from the key's `cc-` prefix. Anchored on the TIER, not the string, so a
 *  continental/global source keyed like `us-…` is never misread as US-only
 *  (mirrors writeRoadAadt's auto-gate; /gg #33 Gemini). Heuristic fills
 *  (service-tree, continuity, taper) are baseline/heuristic tier → excluded. */
function nationalRoadSources(): Array<{ id: number; iso: string; key: string }> {
  const out: Array<{ id: number; iso: string; key: string }> = []
  for (const s of SOURCES) {
    if (s.layer !== 'roads') continue
    if (s.provenance !== 'national-measured' && s.provenance !== 'national-proxy') continue
    const m = /^([a-z]{2})-/.exec(s.key)
    if (!m) continue
    out.push({ id: s.id, iso: m[1].toUpperCase(), key: s.key })
  }
  return out
}

async function main() {
  const world = process.argv.includes('--world')
  const verify = process.argv.includes('--verify')
  const bboxArg = process.argv.includes('--bbox') ? process.argv[process.argv.indexOf('--bbox') + 1] : ''
  const BBOX = bboxArg ? (bboxArg.split(',').map(Number) as [number, number, number, number]) : null
  if (!world && (!BBOX || BBOX.length !== 4 || BBOX.some((x) => !Number.isFinite(x)) || BBOX[0] >= BBOX[2] || BBOX[1] >= BBOX[3])) {
    console.error('Usage: heal-road-country-bleed.ts --bbox S,W,N,E | --world [--verify]  (S<N, W<E)')
    process.exit(1)
  }

  // A territory may have no CGAZ polygon (NC/…) — skip that source. An I/O
  // failure loading CGAZ propagates LOUD from makeOwnershipGate rather than
  // silently skipping (hasCountryPolygon separates the two; /gg #33 Codex).
  const sources: Array<{ id: number; iso: string; key: string }> = []
  const gates = new Map<string, (lat: number, lon: number) => boolean>()
  for (const s of nationalRoadSources()) {
    let g = gates.get(s.iso)
    if (!g) {
      if (!hasCountryPolygon(s.iso)) {
        console.warn(`  no CGAZ polygon for ${s.iso} (source ${s.key}) — skipped`)
        continue
      }
      g = makeOwnershipGate(s.iso) // country + declared territory extensions (MA∪EH)
      gates.set(s.iso, g)
    }
    sources.push(s)
  }
  const byId = new Map(sources.map((s) => [s.id, s]))
  console.log(
    `road country-bleed ${verify ? 'VERIFY (read-only)' : 'heal'}: ${sources.length} national road sources, scope ${world ? 'WORLD' : BBOX!.join(',')}`,
  )

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
    const path = resolve(H3R4_DIR, hex, 'roads.arrow')
    if (!existsSync(path)) continue

    // Cheap read-only probe first: which national road ids own rows here at all?
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
    if (verify) {
      // Read-only twin of the write pass below — roads have no service column,
      // so the only retract condition is the wholly-outside geometry.
      const sLat = t.getChild('start_lat'), sLon = t.getChild('start_lon')
      const eLat = t.getChild('end_lat'), eLon = t.getChild('end_lon')
      if (!sLat || !sLon) continue
      for (let i = 0; i < t.numRows; i++) {
        const id = srcCol.get(i) as number
        if (!id || !byId.has(id)) continue
        const s = byId.get(id)!
        const startLat = sLat.get(i) as number, startLon = sLon.get(i) as number
        const endLat2 = (eLat?.get(i) as number) ?? startLat, endLon2 = (eLon?.get(i) as number) ?? startLon
        const midLat = (endLat2 + startLat) / 2, midLon = (endLon2 + startLon) / 2
        if (segmentWhollyOutside(gates.get(s.iso)!, midLat, midLon, startLat, startLon, endLat2, endLon2)) {
          totalRetracted++
          perSource.set(s.key, (perSource.get(s.key) ?? 0) + 1)
          hexHit = true
        }
      }
    } else {
      for (const id of present) {
        const s = byId.get(id)!
        const inCountry = gates.get(s.iso)!
        const r = await writeRoadAadt(path, () => null, undefined, undefined, {
          sourceId: id,
          when: (row) => segmentWhollyOutside(inCountry, row.midLat, row.midLon, row.startLat, row.startLon, row.endLat, row.endLon),
        })
        if (r.retracted > 0) {
          totalRetracted += r.retracted
          perSource.set(s.key, (perSource.get(s.key) ?? 0) + r.retracted)
          hexHit = true
        }
      }
    }
    if (hexHit) hexesTouched++
  }

  console.log(`\n=== road country-bleed ${verify ? 'verify' : 'heal'} done ===`)
  console.log(
    `  ${totalRetracted.toLocaleString()} foreign rows ${verify ? 'WOULD BE disowned' : 'disowned'} across ${hexesTouched} hexes`,
  )
  for (const [key, n] of [...perSource].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${key}: ${n.toLocaleString()}`)
  }
  if (verify && totalRetracted > 0) {
    console.error('VERIFY FAIL: a road claimer re-stamped rows the heal would retract — fix that enricher, then re-run the chain.')
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })
}
