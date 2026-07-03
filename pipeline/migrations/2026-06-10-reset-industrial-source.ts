// Reset every industrial row currently owned by --source <id> (within --bbox, for a
// fast hex scan) back to source_id=0 + nace_4digit=0, so a re-run of the now
// fuel-gated GEM/heuristic enricher re-stamps from a clean slate.
//
// REQUIRED by the industrial fuel→NACE fix (#53): the fixed enricher SKIPS a plant
// whose fuel maps to null (wind — already source_type=10 — and blank/unknown fuel),
// so a site that wrongly inherited a wind plant's NACE 3512 (90 dB hydro profile) or
// a blank-fuel 3511 (97 dB thermal) stays frozen at that value until its source_id is
// explicitly cleared. After this reset, re-run the country enricher (now skips wind +
// blank, maps hydro→3512, solar→3599, thermal→3511).
//
// Source-id-scoped (same rationale as road/rail): a cleared row is re-claimed by the
// gated re-run, so nothing authoritative is lost.
//
// Usage:
//   DATA_YEAR=2026 npx tsx pipeline/migrations/2026-06-10-reset-industrial-source.ts \
//     --source 330 --bbox 47.2,5.8,55.1,15.1            # GEM national mix
//   add --dry-run to count without writing (truly read-only — no lock, no rewrite).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Uint16, tableFromIPC, vectorFromArray, makeTable, type Table } from 'apache-arrow'
import { withArrowWrite } from '../lib/provenance.js'
import { iterateCountryHexes } from '../lib/roads-arrow.js'
import { DATA_YEAR as YEAR } from '../lib/data-year.js'

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

const hexDirs = iterateCountryHexes(H3R4_DIR, bbox, 'industrial.arrow')
console.log(`Reset source_id=${SOURCE_ID} → 0 over ${hexDirs.length} hexes in bbox ${bboxStr}${DRY ? '  (DRY-RUN)' : ''}`)

let filesChanged = 0
let rowsReset = 0
const t0 = Date.now()

for (let hi = 0; hi < hexDirs.length; hi++) {
  const arrowPath = resolve(H3R4_DIR, hexDirs[hi], 'industrial.arrow')
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

      const naceCol = table.getChild('nace_4digit')
      const nace = new Uint16Array(n)
      const src = new Uint16Array(n)
      for (let i = 0; i < n; i++) {
        if ((srcCol.get(i) as number) === SOURCE_ID) { changedHere++ } // nace=0, src=0
        else {
          src[i] = (srcCol.get(i) as number) ?? 0
          nace[i] = (naceCol?.get(i) as number) ?? 0
        }
      }
      if (changedHere === 0) return table         // no-op → byte-identical

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- apache-arrow overloads (see roads-arrow.ts)
      const rebuilt: Record<string, any> = {}
      for (const f of table.schema.fields) {
        if (f.name === 'nace_4digit' || f.name === 'source_id') continue
        rebuilt[f.name] = table.getChild(f.name)!
      }
      rebuilt['nace_4digit'] = vectorFromArray(nace, new Uint16())
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
