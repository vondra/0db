// Reset every road row currently owned by --source <id> (within --bbox, for a
// fast hex scan) back to source_id=0 + aadt_*=0, so a re-run of the now
// class-gated enricher chain re-stamps from a clean slate.
//
// REQUIRED by the enrichment data-correctness fix (Stage B): writeRoadAadt
// leaves a row UNTOUCHED when match() returns null, and shouldOverwrite forbids
// a lower-rank fixer (service-tree, rank ~heuristic) from repairing a row frozen
// by a higher-rank national source (e.g. US HPMS source_id=21). So a residential
// street that wrongly inherited an interstate's AADT stays frozen until its
// source_id is explicitly cleared. After this reset, re-run the country enricher
// (now gated — re-claims only its real classes) then service-tree (gap-fills the
// freed road_class 5-9 rows where source_id==0).
//
// Source-id-scoped on purpose: do NOT narrow to "small roads only" — bad spatial
// joins don't stop at class 5, and a cleared major road is re-claimed by the
// gated re-run, so nothing is lost (audit Stage B).
//
// Usage:
//   DATA_YEAR=2026 npx tsx pipeline/migrations/2026-06-10-reset-road-source.ts \
//     --source 21 --bbox 17.5,-180,71.5,-65            # US HPMS
//   add --dry-run to count without writing (truly read-only — no lock, no rewrite).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Int32, Uint16, tableFromIPC, vectorFromArray, makeTable, type Table } from 'apache-arrow'
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

const hexDirs = iterateCountryHexes(H3R4_DIR, bbox)
console.log(`Reset source_id=${SOURCE_ID} → 0 over ${hexDirs.length} hexes in bbox ${bboxStr}${DRY ? '  (DRY-RUN)' : ''}`)

let filesChanged = 0
let rowsReset = 0
const t0 = Date.now()

const AADT = ['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto']

for (let hi = 0; hi < hexDirs.length; hi++) {
  const arrowPath = resolve(H3R4_DIR, hexDirs[hi], 'roads.arrow')
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

      const aadtCols = AADT.map(name => table.getChild(name))
      const light = new Int32Array(n), medium = new Int32Array(n)
      const heavy = new Int32Array(n), moto = new Int32Array(n)
      const out = [light, medium, heavy, moto]
      const src = new Uint16Array(n)
      for (let i = 0; i < n; i++) {
        if ((srcCol.get(i) as number) === SOURCE_ID) { changedHere++; src[i] = 0 } // out[*]=0 clears aadt
        else {
          src[i] = (srcCol.get(i) as number) ?? 0
          for (let c = 0; c < 4; c++) out[c][i] = (aadtCols[c]?.get(i) as number) ?? 0
        }
      }
      if (changedHere === 0) return table         // no-op → byte-identical

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- apache-arrow overloads (see roads-arrow.ts)
      const rebuilt: Record<string, any> = {}
      for (const f of table.schema.fields) {
        if ([...AADT, 'source_id'].includes(f.name)) continue
        rebuilt[f.name] = table.getChild(f.name)!
      }
      rebuilt['aadt_light'] = vectorFromArray(light, new Int32())
      rebuilt['aadt_medium'] = vectorFromArray(medium, new Int32())
      rebuilt['aadt_heavy'] = vectorFromArray(heavy, new Int32())
      rebuilt['aadt_moto'] = vectorFromArray(moto, new Int32())
      rebuilt['source_id'] = vectorFromArray(src, new Uint16())
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
