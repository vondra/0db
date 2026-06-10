// Reset every railway row currently owned by --source <id> (within --bbox, for a
// fast hex scan) back to source_id=0 + trains_passenger/freight=0 + parallel_divisor=1,
// so a re-run of the now family-gated enricher re-stamps from a clean slate.
//
// REQUIRED by the enrichment data-correctness fix (rail, #52): the gated enricher
// SKIPS service tracks (sidings/yards), so a siding that wrongly inherited a
// heavy-rail mainline's train count stays frozen at that value until its source_id
// is explicitly cleared. (Non-service rows — incl. trams — ARE re-written in place
// by the gated re-run via defaultTrains, since shouldOverwrite(id,id)=true; the
// reset is needed specifically for the skipped service rows.) After this reset,
// re-run the country enricher (now gated — re-claims real families, fills the rest
// with CNOSSOS class defaults, leaves service rows at 0).
//
// Source-id-scoped on purpose (same rationale as the road reset): a cleared row is
// re-claimed by the gated re-run, so nothing authoritative is lost.
//
// Usage:
//   DATA_YEAR=2026 npx tsx pipeline/migrations/2026-06-10-reset-rail-source.ts \
//     --source 110 --bbox 48.5,12.0,51.1,18.9            # CZ CZPTT (source 110)
//   add --dry-run to count without writing (truly read-only — no lock, no rewrite).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Int32, Uint8, Uint16, tableFromIPC, vectorFromArray, makeTable, type Table } from 'apache-arrow'
import { withArrowWrite } from '../lib/provenance.js'
import { iterateCountryHexes } from '../lib/roads-arrow.js'

const YEAR = process.env.DATA_YEAR || '2026'
const H3R4_DIR = resolve(import.meta.dirname, `../../data/prepared/${YEAR}/h3r4`)

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const SOURCE_ID = Number(arg('--source'))
const DRY = process.argv.includes('--dry-run')
const bboxStr = arg('--bbox')
if (!Number.isInteger(SOURCE_ID) || SOURCE_ID <= 0) throw new Error('need --source <positive int>')
if (!bboxStr) throw new Error('need --bbox minLat,minLon,maxLat,maxLon')
const bbox = bboxStr.split(',').map(Number) as [number, number, number, number]
if (bbox.length !== 4 || bbox.some(n => !Number.isFinite(n))) throw new Error(`bad --bbox: ${bboxStr}`)

const hexDirs = iterateCountryHexes(H3R4_DIR, bbox, 'railways.arrow')
console.log(`Reset source_id=${SOURCE_ID} → 0 over ${hexDirs.length} hexes in bbox ${bboxStr}${DRY ? '  (DRY-RUN)' : ''}`)

let filesChanged = 0
let rowsReset = 0
const t0 = Date.now()

for (let hi = 0; hi < hexDirs.length; hi++) {
  const arrowPath = resolve(H3R4_DIR, hexDirs[hi], 'railways.arrow')
  let changedHere = 0

  if (DRY) {
    // Truly read-only: count owned rows directly — no .lock, no rewrite.
    const table = tableFromIPC(readFileSync(arrowPath))
    const srcCol = table.getChild('source_id')
    if (srcCol) for (let i = 0; i < table.numRows; i++) {
      if ((srcCol.get(i) as number) === SOURCE_ID) changedHere++
    }
  } else {
    await withArrowWrite(arrowPath, (table: Table): Table => {
      const n = table.numRows
      const srcCol = table.getChild('source_id')
      if (n === 0 || !srcCol) return table

      const paxCol = table.getChild('trains_passenger')
      const frtCol = table.getChild('trains_freight')
      const divCol = table.getChild('parallel_divisor') // present only on CZ/europe-touched hexes
      const pax = new Int32Array(n), frt = new Int32Array(n)
      const src = new Uint16Array(n)
      const div = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        if ((srcCol.get(i) as number) === SOURCE_ID) { changedHere++; div[i] = 1 } // pax/frt=0, src=0, divisor=1
        else {
          src[i] = (srcCol.get(i) as number) ?? 0
          pax[i] = (paxCol?.get(i) as number) ?? 0
          frt[i] = (frtCol?.get(i) as number) ?? 0
          div[i] = (divCol?.get(i) as number) ?? 1
        }
      }
      if (changedHere === 0) return table         // no-op → byte-identical

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- apache-arrow overloads (see roads-arrow.ts)
      const rebuilt: Record<string, any> = {}
      const reset = ['trains_passenger', 'trains_freight', 'source_id', 'parallel_divisor']
      for (const f of table.schema.fields) {
        if (reset.includes(f.name)) continue
        rebuilt[f.name] = table.getChild(f.name)!
      }
      rebuilt['trains_passenger'] = vectorFromArray(pax, new Int32())
      rebuilt['trains_freight'] = vectorFromArray(frt, new Int32())
      rebuilt['source_id'] = vectorFromArray(src, new Uint16())
      if (divCol) rebuilt['parallel_divisor'] = vectorFromArray(div, new Uint8())
      return makeTable(rebuilt)
    })
  }
  if (changedHere > 0) { filesChanged++; rowsReset += changedHere }

  if (hi % 500 === 0 || hi === hexDirs.length - 1) {
    const dt = ((Date.now() - t0) / 1000).toFixed(0)
    console.log(`  [${dt}s] ${hi + 1}/${hexDirs.length} hexes, ${filesChanged} changed, ${rowsReset.toLocaleString()} rows reset`)
  }
}

console.log(`\nDone${DRY ? ' (DRY-RUN — nothing written)' : ''}: ${filesChanged} files changed, ${rowsReset.toLocaleString()} rows reset, ${((Date.now() - t0) / 1000).toFixed(0)}s`)
