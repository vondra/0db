//! Zero-write heal for ROADS — the write-side twin of auditor rule R7: a row
//! stamped by a MEASURED road source (city/national/continental/global tier)
//! with all-zero AADT is a loader/join failure, never data (a closed road is
//! ABSENT from a census, not surveyed as 0/0/0/0). The writer has rejected
//! such payloads since #31.4, but rows written by pre-guard runs are still in
//! the arrows (world gate 2026-07-12: de-bast 3152, es 982, pl 1015). One-off
//! by nature — post-#31.4 writers cannot create new ones.
//!
//! Clears the four AADT columns + source_id + speed_taper (a disowned row's
//! taper refinement is void with it), so the row falls back to the engine's
//! class default and is open for re-claim on the next chain run. Only ever
//! touches MEASURED ids — a zero under a heuristic/baseline tier (the R7 taper
//! stamps speed-only rows with zero AADT BY DESIGN) is legal and left alone.
//!
//! Usage:
//!   DATA_YEAR=2026 npx tsx pipeline/heal-road-zero-write.ts --bbox S,W,N,E
//!   DATA_YEAR=2026 npx tsx pipeline/heal-road-zero-write.ts --world
//!   … --verify   report-only: writes NOTHING, exits 1 when it WOULD clear
//!                anything. The chain runs the heal BEFORE the road claimers;
//!                the final unsampled auditor (R7) is the post-claimer tripwire.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, makeVector, makeTable, type Table } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'
import { isMeasured } from './lib/sources.js'
import { withArrowWrite } from './lib/provenance.js'
import { inBbox } from './lib/spatial.js'
import { DATA_YEAR as YEAR } from './lib/data-year.js'

const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

/** All four AADT columns zero on row i. */
function allZero(l: number, m: number, h: number, mo: number): boolean {
  return l === 0 && m === 0 && h === 0 && mo === 0
}

async function main() {
  const world = process.argv.includes('--world')
  const verify = process.argv.includes('--verify')
  const bboxArg = process.argv.includes('--bbox') ? process.argv[process.argv.indexOf('--bbox') + 1] : ''
  const BBOX = bboxArg ? (bboxArg.split(',').map(Number) as [number, number, number, number]) : null
  if (!world && (!BBOX || BBOX.length !== 4 || BBOX.some((x) => !Number.isFinite(x)) || BBOX[0] >= BBOX[2] || BBOX[1] >= BBOX[3])) {
    console.error('Usage: heal-road-zero-write.ts --bbox S,W,N,E | --world [--verify]  (S<N, W<E)')
    process.exit(1)
  }
  console.log(`road zero-write ${verify ? 'VERIFY (read-only)' : 'heal'}: scope ${world ? 'WORLD' : BBOX!.join(',')}`)

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
    const path = resolve(H3R4_DIR, hex, 'roads.arrow')
    if (!existsSync(path)) continue

    // Read-only probe: any measured+all-zero rows here at all?
    const t = tableFromIPC(readFileSync(path))
    const src = t.getChild('source_id')
    const l = t.getChild('aadt_light'), m = t.getChild('aadt_medium')
    const h = t.getChild('aadt_heavy'), mo = t.getChild('aadt_moto')
    if (!src || !l || !m || !h || !mo) continue
    let probeHits = 0
    for (let i = 0; i < t.numRows; i++) {
      const id = src.get(i) as number
      if (id && isMeasured(id) && allZero(l.get(i) as number, m.get(i) as number, h.get(i) as number, mo.get(i) as number)) probeHits++
    }
    if (probeHits === 0) continue

    hexesTouched++
    if (verify) {
      totalCleared += probeHits
      continue
    }

    // Re-classify on the LOCKED table (a concurrent writer may have replaced a
    // row between probe and lock — never clear on stale indexes; #31 round-3).
    let clearedHere = 0
    await withArrowWrite(path, (table: Table): Table => {
      const n = table.numRows
      const srcCol = table.getChild('source_id')
      const lCol = table.getChild('aadt_light'), mCol = table.getChild('aadt_medium')
      const hCol = table.getChild('aadt_heavy'), moCol = table.getChild('aadt_moto')
      const taperCol = table.getChild('speed_taper')
      if (!srcCol || !lCol || !mCol || !hCol || !moCol) return table
      const toClear = new Set<number>()
      for (let i = 0; i < n; i++) {
        const id = srcCol.get(i) as number
        if (id && isMeasured(id) && allZero(lCol.get(i) as number, mCol.get(i) as number, hCol.get(i) as number, moCol.get(i) as number)) toClear.add(i)
      }
      if (toClear.size === 0) return table
      clearedHere = toClear.size
      const srcOut = new Uint16Array(n)
      const taperOut = taperCol ? new Uint8Array(n) : null
      for (let i = 0; i < n; i++) {
        srcOut[i] = toClear.has(i) ? 0 : ((srcCol.get(i) as number) ?? 0)
        if (taperOut) taperOut[i] = toClear.has(i) ? 0 : ((taperCol!.get(i) as number) ?? 0)
      }
      // AADT columns are already all-zero on the cleared rows (that IS the bug
      // shape), so only source_id (and speed_taper, void with the disown) move.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixed Vector/makeVector
      const cols: Record<string, any> = {}
      for (const f of table.schema.fields) {
        if (f.name === 'source_id' || (taperOut && f.name === 'speed_taper')) continue
        cols[f.name] = table.getChild(f.name)!
      }
      cols['source_id'] = makeVector(srcOut)
      if (taperOut) cols['speed_taper'] = makeVector(taperOut)
      return makeTable(cols)
    })
    totalCleared += clearedHere
  }

  console.log(`\n=== road zero-write ${verify ? 'verify' : 'heal'} done ===`)
  console.log(`  ${totalCleared.toLocaleString()} measured all-zero rows ${verify ? 'WOULD BE' : ''} cleared across ${hexesTouched} hexes`)
  if (verify && totalCleared > 0) {
    console.error('VERIFY FAIL: a road claimer re-stamped measured all-zero rows — fix that enricher, then re-run the chain.')
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })
}
