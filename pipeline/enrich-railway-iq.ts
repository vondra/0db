/**
 * Enrich IQ railways.arrow with Iraq corridor defaults.
 *
 * **Iraqi Republic Railways** operates ~2,400 km standard gauge (1,435 mm).
 * Mostly non-functional post-2003 invasion + ISIS destruction 2014-2017.
 * Baghdad has NO metro (planned but never built).
 *
 * 1. **Baghdad–Basra** — the only PARTIALLY RESTORED corridor with any
 *    regular service. Runs south along the Tigris/Euphrates plain through
 *    Kut, Amarah, Qurna to Basra. Pre-2003 was the backbone line.
 *    Current service: very limited, few trains/day.
 *
 * 2. **Baghdad–Mosul** (Main Line North) — through Baiji, Tikrit to Mosul.
 *    Severely damaged by ISIS, largely non-operational; minimal freight only.
 *
 * 3. **Baghdad–Fallujah–Ramadi–Husaybah** (Western line to Syrian border) —
 *    non-operational since 2003; infrastructure partially destroyed.
 *
 * 4. **Basra–Umm Qasr** (port spur, strategic freight) — Iraq's only deep-
 *    water port, Container Terminal, grain imports. Short but important.
 *
 * ## trains/day defaults
 *
 *   | Context | pax/day | frt/day |
 *   |---|---:|---:|
 *   | **Baghdad–Basra** (partially restored main line) | 3 | 4 |
 *   | **Basra–Umm Qasr** (port freight spur) | 0 | 2 |
 *   | Other/branch (minimal/non-functional) | 0 | 1 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-iq.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32, Uint16 } from 'apache-arrow'
import { DATASETS_BY_KEY } from './lib/enrichment-datasets.js'
import { shouldOverwrite } from './lib/provenance.js'
import { cellToLatLng } from 'h3-js'

const MY_DATASET_ID = DATASETS_BY_KEY.get('iq-national-railway')!.id

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Iraq bbox [minLat, minLon, maxLat, maxLon]
const IQ_BBOX: [number, number, number, number] = [29.0, 38.7, 37.4, 48.6]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Turkey N',      bbox: [37.2, 38.7, 37.4, 45.0] },
  { name: 'Iran E high',   bbox: [32.0, 46.5, 37.4, 48.6] },
  { name: 'Iran E low',    bbox: [29.0, 48.0, 32.0, 48.6] },
  { name: 'Kuwait SE',     bbox: [29.0, 46.5, 29.5, 48.6] },
  { name: 'Saudi Arabia S',bbox: [29.0, 38.7, 29.4, 48.6] },
  { name: 'Syria W',       bbox: [33.0, 38.7, 37.4, 40.5] },
  { name: 'Jordan SW',     bbox: [29.0, 38.7, 33.0, 39.5] },
]

// Baghdad–Basra main line: runs south through central/southern Iraq
const BAGHDAD_BASRA: [number, number, number, number] = [30.5, 44.0, 33.5, 46.5]

// Basra–Umm Qasr port spur (very south, near Kuwait border)
const BASRA_UMM_QASR: [number, number, number, number] = [29.9, 47.5, 30.6, 48.0]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyExclude(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

function classifyRail(lat: number, lon: number): { pax: number; frt: number; zone: string } {
  if (inBbox(lat, lon, BASRA_UMM_QASR)) return { pax: 0, frt: 2, zone: 'Basra–Umm Qasr port spur' }
  if (inBbox(lat, lon, BAGHDAD_BASRA)) return { pax: 3, frt: 4, zone: 'Baghdad–Basra main line' }
  return { pax: 0, frt: 1, zone: 'other' }
}

async function main() {
  console.log(`=== IQ Railway Enrichment — Iraq corridor defaults (${YEAR}) ===\n`)
  console.log(`  Note: Iraqi Republic Railways ~2,400 km standard gauge (1,435 mm), mostly non-functional post-2003 + ISIS.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, IQ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  IQ-bbox hexes with railways.arrow: ${hexDirs.length}`)

  let totalSeg = 0, excluded = 0, alreadyEnriched = 0, matched = 0, hexesUpdated = 0
  const zoneCounts: Record<string, number> = {}

  for (const hex of hexDirs) {
    const rp = resolve(H3R4_DIR, hex, 'railways.arrow')
    const buf = readFileSync(rp)
    const table = tableFromIPC(buf)
    const n = table.numRows
    if (n === 0) continue
    const startLat = table.getChild('start_lat')!
    const startLon = table.getChild('start_lon')!
    const endLat = table.getChild('end_lat')!
    const endLon = table.getChild('end_lon')!
    const existingPax = table.getChild('trains_passenger')
    const existingFrt = table.getChild('trains_freight')
    const existingDatasetId = table.getChild('railways_dataset_id')
    const pax = new Int32Array(n)
    const frt = new Int32Array(n)
    const datasetId = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      pax[i] = (existingPax?.get(i) as number) ?? 0
      frt[i] = (existingFrt?.get(i) as number) ?? 0

      datasetId[i] = existingDatasetId ? (existingDatasetId.get(i) as number) ?? 0 : 0
    }
    totalSeg += n
    let hexMatched = 0
    for (let i = 0; i < n; i++) {
      if (!shouldOverwrite(datasetId[i], MY_DATASET_ID)) continue
      const midLat = ((startLat.get(i) as number) + (endLat.get(i) as number)) / 2
      const midLon = ((startLon.get(i) as number) + (endLon.get(i) as number)) / 2
      if (!inBbox(midLat, midLon, IQ_BBOX)) continue
      if (inAnyExclude(midLat, midLon)) { excluded++; continue }
      const c = classifyRail(midLat, midLon)
      pax[i] = c.pax; frt[i] = c.frt; datasetId[i] = MY_DATASET_ID
      zoneCounts[c.zone] = (zoneCounts[c.zone] || 0) + 1
      hexMatched++; matched++
    }
    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['trains_passenger', 'trains_freight', 'railways_dataset_id'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['trains_passenger'] = vectorFromArray(pax, new Int32())
      columns['trains_freight'] = vectorFromArray(frt, new Int32())

      columns['railways_dataset_id'] = vectorFromArray(datasetId, new Uint16())
      const newTable = makeTable(columns)
      writeFileSync(rp, Buffer.from(tableToIPC(newTable, 'file')))
      hexesUpdated++
    }
  }

  console.log(`\n=== Results ===`)
  console.log(`  Total segments scanned:   ${totalSeg.toLocaleString()}`)
  console.log(`  Already enriched (skip):  ${alreadyEnriched.toLocaleString()}`)
  console.log(`  Excluded (neighbours):    ${excluded.toLocaleString()}`)
  console.log(`  Matched by corridor:      ${matched.toLocaleString()}`)
  console.log(`  Hexes updated:            ${hexesUpdated}/${hexDirs.length}`)
  console.log(`\n  Zone distribution:`)
  for (const [z, c] of Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${z.padEnd(30)} ${c.toLocaleString()}`)
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
