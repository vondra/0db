/**
 * Enrich TR railways.arrow with Turkey corridor defaults.
 *
 * **TCDD (Türkiye Cumhuriyeti Devlet Demiryolları)** operates ~12,500 km
 * standard gauge (1,435 mm) — one of the world's larger rail networks.
 * British/French-era infrastructure, extensively modernised 2000s–2020s.
 *
 * 1. **YHT (Yüksek Hızlı Tren) — High-Speed Rail**
 *    - Ankara ↔ İstanbul (2014, 4.5h, 250 km/h, ~4.5M pax/yr)
 *    - Ankara ↔ Konya (2011, 1.5h, 250 km/h)
 *    - Ankara ↔ Sivas (2024 extension, Yozgat/Sivas)
 *    - Konya ↔ Karaman (2022)
 *
 * 2. **İstanbul Metro** (7+ lines, ~115 km, ~1.5M daily riders)
 *    - M1A/M1B (airport–Yenikapı), M2 (Yenikapı–Hacıosman),
 *      M3 (Kirazlı–Olimpiyat), M4 (Kadıköy–Sabiha Gökçen),
 *      M5 (Üsküdar–Çekmeköy), M6, M7
 *
 * 3. **Marmaray** (undersea Bosphorus rail tunnel, 2013 — connects Asia+Europe,
 *    ~150 pax trains/day, major cross-city commuter line)
 *
 * 4. **Ankara Metro** — Ankaray LRT (M1) + M2 (Kızılay–OSB) + M3 (Batıkent–OSB)
 *
 * 5. **İzmir Metro** (2 lines: M1 + M2) + IZBAN commuter rail (İzmir–Aliağa/Selçuk)
 *
 * 6. **Bursa Metro** (BursaRay — 2 lines, B1 + B2, Nilüfer valley)
 *
 * 7. **Regional tramways**: Kayseri, Konya, Antalya, Gaziantep, Samsun
 *    (all opened 2010s, modern Alstom/CAF vehicles)
 *
 * ## trains/day defaults
 *
 *   | Context | pax/day | frt/day |
 *   |---|---:|---:|
 *   | **İstanbul Metro** (urban metro — M1–M7) | 350 | 0 |
 *   | **Marmaray** (Bosphorus tunnel commuter) | 150 | 0 |
 *   | **YHT corridor** (Ankara–İstanbul/Konya/Sivas HSR) | 30 | 0 |
 *   | **Ankara/İzmir/Bursa metro** | 100 | 0 |
 *   | **TCDD conventional main** (inter-city + regional) | 10 | 15 |
 *   | Other/branch | 3 | 5 |
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-railway-tr.ts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, makeTable, Int32 } from 'apache-arrow'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)

// Turkey bbox [minLat, minLon, maxLat, maxLon]
const TR_BBOX: [number, number, number, number] = [35.8, 25.6, 42.2, 44.8]

const EXCLUDE_ZONES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Greece/Bulgaria W',  bbox: [40.5, 25.6, 42.2, 26.5] },
  { name: 'Georgia NE',         bbox: [41.0, 42.5, 42.2, 44.8] },
  { name: 'Armenia NE',         bbox: [39.0, 43.5, 42.2, 44.8] },
  { name: 'Iran E',             bbox: [35.8, 44.0, 39.8, 44.8] },
  { name: 'Iraq SE',            bbox: [35.8, 42.0, 37.5, 44.8] },
  { name: 'Syria S',            bbox: [35.8, 36.0, 36.2, 44.8] },
]

// İstanbul Metro (M1–M7 urban metro lines, both European + Asian sides)
const ISTANBUL_METRO: [number, number, number, number] = [40.85, 28.60, 41.20, 29.20]

// Marmaray Bosphorus tunnel corridor (tight band crossing the strait)
const MARMARAY: [number, number, number, number] = [40.97, 28.85, 41.05, 29.10]

// YHT high-speed corridor: Ankara ↔ İstanbul / Konya / Sivas (broad band)
const YHT_CORRIDOR: [number, number, number, number] = [37.6, 29.5, 40.9, 36.0]

// Ankara Metro (Ankaray + M2/M3 urban metro, tight Ankara bbox)
const ANKARA_METRO: [number, number, number, number] = [39.85, 32.70, 40.05, 33.00]

// İzmir Metro + IZBAN commuter (İzmir metropolitan area)
const IZMIR_METRO: [number, number, number, number] = [38.30, 26.90, 38.55, 27.25]

// Bursa Metro (BursaRay urban lines)
const BURSA_METRO: [number, number, number, number] = [40.15, 28.90, 40.25, 29.10]

function inBbox(lat: number, lon: number, bbox: [number, number, number, number]): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lon >= bbox[1] && lon <= bbox[3]
}
function inAnyExclude(lat: number, lon: number): boolean {
  for (const z of EXCLUDE_ZONES) if (inBbox(lat, lon, z.bbox)) return true
  return false
}

function classifyRail(lat: number, lon: number): { pax: number; frt: number; zone: string } {
  if (inBbox(lat, lon, MARMARAY))       return { pax: 150, frt: 0,  zone: 'Marmaray Bosphorus tunnel' }
  if (inBbox(lat, lon, ISTANBUL_METRO)) return { pax: 350, frt: 0,  zone: 'İstanbul Metro' }
  if (inBbox(lat, lon, ANKARA_METRO))   return { pax: 100, frt: 0,  zone: 'Ankara Metro' }
  if (inBbox(lat, lon, IZMIR_METRO))    return { pax: 100, frt: 0,  zone: 'İzmir Metro/IZBAN' }
  if (inBbox(lat, lon, BURSA_METRO))    return { pax: 100, frt: 0,  zone: 'Bursa Metro (BursaRay)' }
  if (inBbox(lat, lon, YHT_CORRIDOR))   return { pax: 30,  frt: 0,  zone: 'YHT high-speed corridor' }
  return { pax: 10, frt: 15, zone: 'TCDD conventional main' }
}

async function main() {
  console.log(`=== TR Railway Enrichment — Turkey corridor defaults (${YEAR}) ===\n`)
  console.log(`  Note: TCDD ~12,500 km standard gauge (1,435 mm); YHT HSR 2011–2024.\n`)

  const allHexes = readdirSync(H3R4_DIR).filter(d => d.length === 15 && d.endsWith('ffffffff'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (inBbox(lat, lon, TR_BBOX) && existsSync(resolve(H3R4_DIR, hex, 'railways.arrow'))) hexDirs.push(hex)
    } catch {}
  }
  console.log(`  TR-bbox hexes with railways.arrow: ${hexDirs.length}`)

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
      if (!inBbox(midLat, midLon, TR_BBOX)) continue
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
    console.log(`    ${z.padEnd(35)} ${c.toLocaleString()}`)
  }
}

main().catch(err => { console.error('Error:', err); process.exit(1) })
