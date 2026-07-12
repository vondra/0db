//! Orphan sweep for the SHARED industrial id 330 — the heal half of the
//! auditor's R14 rule: a national-mix stamp whose centroid lies in NO CGAZ
//! country (open sea, coastline sliver, boundary gap) is unreachable by every
//! national pass since #31 — both destructive arms of `stampOneWinner` are
//! countryGate-scoped — so it can only be stale legacy and would otherwise
//! survive forever. One-off by nature: post-#31 writers cannot create new
//! orphans (the winner mask is countryGate-scoped too).
//!
//! Clears `nace_4digit` + `source_id` (the row falls back to the engine's
//! OSM-class default), via withArrowWrite. Only ever touches id 330 — bespoke
//! per-country ids have country identity and belong to R9/heal-rail-style
//! machinery instead.
//!
//! Usage:
//!   DATA_YEAR=2026 npx tsx pipeline/heal-industrial-orphans.ts --bbox S,W,N,E
//!   DATA_YEAR=2026 npx tsx pipeline/heal-industrial-orphans.ts --world
//!   … --verify   report-only: writes NOTHING, exits 1 when the heal WOULD
//!                clear anything. In the chain the heal runs BEFORE every
//!                industrial claimer (incl. global-industrial — same-rank GPPD
//!                must get the freed rows in the same run); the final
//!                unsampled auditor (R14) is the post-claimer tripwire.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'
import { makeAnyCountryGate } from './lib/country-polygon.js'
import { withArrowWrite } from './lib/provenance.js'
import { SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX } from './lib/source-ids.generated.js'
import { inBbox } from './lib/spatial.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'
import { makeVector, makeTable, type Table } from 'apache-arrow'

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const SHARED_ID = SOURCE_ID_GLOBAL_INDUSTRIAL_NATIONAL_MIX

async function main() {
  const world = process.argv.includes('--world')
  const verify = process.argv.includes('--verify')
  const bboxArg = process.argv.includes('--bbox') ? process.argv[process.argv.indexOf('--bbox') + 1] : ''
  const BBOX = bboxArg ? (bboxArg.split(',').map(Number) as [number, number, number, number]) : null
  if (!world && (!BBOX || BBOX.length !== 4 || BBOX.some((x) => !Number.isFinite(x)))) {
    console.error('Usage: heal-industrial-orphans.ts --bbox S,W,N,E | --world [--verify]')
    process.exit(1)
  }

  const inAnyCountry = makeAnyCountryGate()
  console.log(`industrial-orphan ${verify ? 'VERIFY (read-only)' : 'heal'}: shared id ${SHARED_ID}, scope ${world ? 'WORLD' : BBOX!.join(',')}`)

  let hexesTouched = 0
  let totalCleared = 0

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
    const path = resolve(H3R4_DIR, hex, 'industrial.arrow')
    if (!existsSync(path)) continue

    // Read-only probe: any orphaned shared-id rows here at all?
    const t = tableFromIPC(readFileSync(path))
    const src = t.getChild('source_id')
    const la = t.getChild('centroid_lat')
    const lo = t.getChild('centroid_lon')
    if (!src || !la || !lo) continue
    const orphanRows: number[] = []
    for (let i = 0; i < t.numRows; i++) {
      if ((src.get(i) as number) !== SHARED_ID) continue
      const lat = la.get(i) as number, lon = lo.get(i) as number
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      if (!inAnyCountry(lat, lon)) orphanRows.push(i)
    }
    if (orphanRows.length === 0) continue

    hexesTouched++
    if (verify) {
      totalCleared += orphanRows.length
      continue
    }

    // The unlocked probe above only decided WHETHER to take the lock; the
    // authoritative classification re-runs on the LOCKED table — a concurrent
    // writer may have replaced a 330 row with a higher-rank source between the
    // two reads, and stale indexes would wipe it (round-3 Codex).
    let clearedHere = 0
    await withArrowWrite(path, (table: Table): Table => {
      const n = table.numRows
      const naceCol = table.getChild('nace_4digit')
      const srcCol = table.getChild('source_id')
      const laCol = table.getChild('centroid_lat')
      const loCol = table.getChild('centroid_lon')
      if (!naceCol || !srcCol || !laCol || !loCol) return table
      const toClear = new Set<number>()
      for (let i = 0; i < n; i++) {
        if ((srcCol.get(i) as number) !== SHARED_ID) continue
        const lat = laCol.get(i) as number, lon = loCol.get(i) as number
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
        if (!inAnyCountry(lat, lon)) toClear.add(i)
      }
      if (toClear.size === 0) return table
      clearedHere = toClear.size
      const nace = new Uint16Array(n)
      const srcId = new Uint16Array(n)
      for (let i = 0; i < n; i++) {
        nace[i] = toClear.has(i) ? 0 : ((naceCol.get(i) as number) ?? 0)
        srcId[i] = toClear.has(i) ? 0 : ((srcCol.get(i) as number) ?? 0)
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixed Vector/makeVector
      const cols: Record<string, any> = {}
      for (const f of table.schema.fields) {
        if (f.name === 'nace_4digit' || f.name === 'source_id') continue
        cols[f.name] = table.getChild(f.name)!
      }
      cols['nace_4digit'] = makeVector(nace)
      cols['source_id'] = makeVector(srcId)
      return makeTable(cols)
    })
    totalCleared += clearedHere
  }

  console.log(`\n=== industrial-orphan ${verify ? 'verify' : 'heal'} done ===`)
  console.log(`  ${totalCleared.toLocaleString()} orphaned shared-id rows ${verify ? 'WOULD BE' : ''} cleared across ${hexesTouched} hexes`)
  if (verify && totalCleared > 0) {
    console.error('VERIFY FAIL: an industrial claimer stamped rows outside every country — fix that pass (auditor R14 fires on these).')
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })
}
