/**
 * Enrich KZ railways.arrow with Kazakhstan corridor defaults.
 *
 * **KTZ (Kazakhstan Temir Zholy)** operates ~16,600 km broad gauge (1,520 mm) —
 * one of the world's largest rail networks. Soviet-era, massive freight
 * capacity (oil, grain, coal, uranium, China-Europe transit).
 *
 * 1. **Almaty Metro** (opened 2011, 1 line, 11 km, 9 stations —
 *    one of the world's newest metros, Almaty urban core)
 *
 * 2. **Astana LRT** (opened 2024, 22 km — Expo Line, Astana urban)
 *
 * 3. **Almaty ↔ Astana main line** (north-south backbone ~1,300 km —
 *    Kazakhstan's busiest intercity corridor)
 *
 * 4. **Ekibastuz coal corridor** (coal trains Pavlodar/Ekibastuz→all over KZ —
 *    extreme coal freight, Soviet-era heavy tonnage)
 *
 * 5. **Trans-Kazakh corridor** (Aktau↔Aktobe↔Astana↔East — China-Europe
 *    freight transit, growing container volumes)
 *
 * ## trains/day defaults
 *
 *   | Context | pax/day | frt/day |
 *   |---|---:|---:|
 *   | **Almaty Metro** (urban, tight Almaty core) | 80 | 0 |
 *   | **Astana LRT** (urban, tight Astana core) | 50 | 0 |
 *   | **Almaty–Astana main line** (north-south backbone) | 8 | 20 |
 *   | **Ekibastuz coal corridor** (Pavlodar/Ekibastuz, extreme freight) | 2 | 30 |
 *   | Other/branch | 2 | 10 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-kz.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Kazakhstan bbox [minLat, minLon, maxLat, maxLon]
const KZ_BBOX: [number, number, number, number] = [40.5, 46.4, 55.5, 87.4]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Russia N (W)',      bbox: [54.5, 46.4, 55.5, 70.0] },
  { name: 'Russia N (E)',      bbox: [53.5, 70.0, 55.5, 87.4] },
  { name: 'China E',           bbox: [40.5, 81.0, 47.0, 87.4] },
  { name: 'Kyrgyzstan SE',     bbox: [40.5, 72.0, 43.0, 87.4] },
  { name: 'Uzbekistan S',      bbox: [40.5, 46.4, 41.5, 69.0] },
  { name: 'Turkmenistan SW',   bbox: [40.5, 46.4, 42.0, 53.0] },
]

// Almaty Metro: urban core of Almaty
const ALMATY_METRO: [number, number, number, number] = [43.18, 76.85, 43.32, 77.05]

// Astana LRT: urban core of Astana
const ASTANA_LRT: [number, number, number, number] = [51.12, 71.35, 51.25, 71.55]

// Almaty–Astana main line: north-south backbone corridor
const ALMATY_ASTANA_MAIN: [number, number, number, number] = [43.0, 71.3, 51.5, 77.2]

// Ekibastuz coal corridor: Pavlodar/Ekibastuz heavy coal freight
const EKIBASTUZ_COAL: [number, number, number, number] = [51.5, 72.5, 53.5, 77.5]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyExclude(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

function classifyRail(lat: number, lon: number): { pax: number; frt: number; zone: string } {
  if (inBbox(lat, lon, ALMATY_METRO))        return { pax: 80, frt: 0,  zone: 'Almaty Metro' }
  if (inBbox(lat, lon, ASTANA_LRT))          return { pax: 50, frt: 0,  zone: 'Astana LRT' }
  if (inBbox(lat, lon, EKIBASTUZ_COAL))      return { pax: 2,  frt: 30, zone: 'Ekibastuz coal corridor' }
  if (inBbox(lat, lon, ALMATY_ASTANA_MAIN))  return { pax: 8,  frt: 20, zone: 'Almaty–Astana main line' }
  return { pax: 2, frt: 10, zone: 'other' }
}

async function main() {
  console.log(`=== KZ Railway Enrichment — Kazakhstan corridor defaults (${YEAR}) ===\n`)
  console.log(`  Note: KTZ ~16,600 km broad gauge (1,520 mm), Soviet-era, massive freight capacity.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, KZ_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  KZ-bbox hexes with railways.arrow: ${hexDirs.length}`)

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
    const pax = new Int32Array(n)
    const frt = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      pax[i] = (existingPax?.get(i) as number) ?? 0
      frt[i] = (existingFrt?.get(i) as number) ?? 0
    }
    totalSeg += n
    let hexMatched = 0
    for (let i = 0; i < n; i++) {
      if (pax[i] > 0 || frt[i] > 0) { alreadyEnriched++; continue }
      const midLat = ((startLat.get(i) as number) + (endLat.get(i) as number)) / 2
      const midLon = ((startLon.get(i) as number) + (endLon.get(i) as number)) / 2
      if (!inBbox(midLat, midLon, KZ_BBOX)) continue
      if (inAnyExclude(midLat, midLon)) { excluded++; continue }
      const c = classifyRail(midLat, midLon)
      pax[i] = c.pax; frt[i] = c.frt
      zoneCounts[c.zone] = (zoneCounts[c.zone] || 0) + 1
      hexMatched++; matched++
    }
    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['trains_passenger', 'trains_freight'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['trains_passenger'] = vectorFromArray(pax, new Int32())
      columns['trains_freight'] = vectorFromArray(frt, new Int32())
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
