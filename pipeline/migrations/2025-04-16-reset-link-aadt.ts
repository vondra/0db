// Reset motorway_link / trunk_link / primary_link (class 10-12) rows that
// service-tree stamped before its filter was tightened. Those rows keep
// traffic_source=2 + a tiny flow-accumulation AADT, suppressing the 20 %-of-
// mainline class default the engine would otherwise apply. Set them back to
// traffic_source=0, aadt=0, dataset_id=0 so normalize_road() takes the default.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
  makeTable,
  Int32,
  Uint8,
  Uint16,
} from 'apache-arrow'
import { SOURCES_BY_KEY } from '../lib/sources.js'
import { SOURCE_ID_SERVICE_TREE_HEURISTIC } from '../lib/source-ids.generated.js'

const YEAR = process.env.DATA_YEAR || '2025'
const DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const PREFIX = process.argv.includes('--prefix')
  ? process.argv[process.argv.indexOf('--prefix') + 1]
  : ''

const SERVICE_TREE_DATASET_ID = SOURCE_ID_SERVICE_TREE_HEURISTIC

const hexDirs = readdirSync(DIR)
  .filter((h) => /^[0-9a-f]{15}$/.test(h))
  .filter((h) => !PREFIX || h.startsWith(PREFIX))
  .sort()

let filesTotal = 0
let filesChanged = 0
let rowsReset = 0
const t0 = Date.now()

for (const hex of hexDirs) {
  const p = resolve(DIR, hex, 'roads.arrow')
  try {
    statSync(p)
  } catch {
    continue
  }
  filesTotal++

  const table = tableFromIPC(readFileSync(p))
  const rc = table.getChild('road_class')
  const ts = table.getChild('traffic_source')
  const al = table.getChild('aadt_light')
  const am = table.getChild('aadt_medium')
  const ah = table.getChild('aadt_heavy')
  const ax = table.getChild('aadt_moto')
  const ds = table.getChild('roads_dataset_id')
  if (!rc || !ts || !al || !am || !ah || !ax || !ds) continue

  const n = rc.length
  const rcArr = new Uint8Array(n)
  const tsArr = new Uint8Array(n)
  const alArr = new Int32Array(n)
  const amArr = new Int32Array(n)
  const ahArr = new Int32Array(n)
  const axArr = new Int32Array(n)
  const dsArr = new Uint16Array(n)
  let changedHere = 0
  for (let i = 0; i < n; i++) {
    const cls = rc.get(i) as number
    rcArr[i] = cls
    if (cls >= 10 && cls <= 12 && (ds.get(i) as number) === SERVICE_TREE_DATASET_ID) {
      tsArr[i] = 0
      alArr[i] = 0
      amArr[i] = 0
      ahArr[i] = 0
      axArr[i] = 0
      dsArr[i] = 0
      changedHere++
    } else {
      tsArr[i] = ts.get(i) as number
      alArr[i] = al.get(i) as number
      amArr[i] = am.get(i) as number
      ahArr[i] = ah.get(i) as number
      axArr[i] = ax.get(i) as number
      dsArr[i] = ds.get(i) as number
    }
  }

  if (changedHere > 0) {
    filesChanged++
    rowsReset += changedHere
    const fields = table.schema.fields
    const newData: Record<string, unknown> = {}
    for (const f of fields) {
      switch (f.name) {
        case 'road_class':
          newData[f.name] = vectorFromArray(rcArr, new Uint8())
          break
        case 'traffic_source':
          newData[f.name] = vectorFromArray(tsArr, new Uint8())
          break
        case 'aadt_light':
          newData[f.name] = vectorFromArray(alArr, new Int32())
          break
        case 'aadt_medium':
          newData[f.name] = vectorFromArray(amArr, new Int32())
          break
        case 'aadt_heavy':
          newData[f.name] = vectorFromArray(ahArr, new Int32())
          break
        case 'aadt_moto':
          newData[f.name] = vectorFromArray(axArr, new Int32())
          break
        case 'roads_dataset_id':
          newData[f.name] = vectorFromArray(dsArr, new Uint16())
          break
        default:
          newData[f.name] = table.getChild(f.name)
      }
    }
    const newTable = makeTable(newData as never)
    writeFileSync(p, tableToIPC(newTable, 'file'))
  }

  if (filesTotal % 5000 === 0) {
    const dt = ((Date.now() - t0) / 1000).toFixed(0)
    console.log(
      `[${dt}s] ${filesTotal} files, ${filesChanged} changed, ${rowsReset} rows reset`,
    )
  }
}

console.log(
  `\nDone. files: ${filesTotal} scanned, ${filesChanged} changed, ${rowsReset} rows reset, ${(
    (Date.now() - t0) / 1000
  ).toFixed(0)}s`,
)
