/**
 * Enrich FR roads.arrow with Cerema TMJA traffic census data.
 *
 * Downloads TMJA CSV from data.gouv.fr, parses per-section AADT + heavy share,
 * converts Lambert-93→WGS84, matches to OSM roads by route ref + proximity.
 *
 * Usage:
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-fr.ts
 *   DATA_YEAR=2025 npx tsx pipeline/enrich-roads-fr.ts --enrich-only
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { tableFromIPC, tableToIPC, vectorFromArray, Int32, Uint8 } from 'apache-arrow'
import proj4 from 'proj4'
import { cellToLatLng } from 'h3-js'

const YEAR = process.env.DATA_YEAR || '2025'
const H3R4_DIR = resolve(import.meta.dirname, `../data/prepared/${YEAR}/h3r4`)
const CACHE_DIR = resolve(import.meta.dirname, `../data/enrichment/${YEAR}/fr`)
const CACHE_2024 = resolve(CACHE_DIR, 'tmja-2024.csv')
const CACHE_2019 = resolve(CACHE_DIR, 'tmja-2019.csv')
const CACHE_JSON = resolve(CACHE_DIR, 'tmja-census.json')

const enrichOnly = process.argv.includes('--enrich-only')
const forceDownload = process.argv.includes('--force-download')

const TMJA_2024_URL = 'https://static.data.gouv.fr/resources/trafic-moyen-journalier-annuel-sur-le-reseau-routier-national/20250818-100154/tmja-rrnc-2024.csv'
const TMJA_2019_URL = 'https://static.data.gouv.fr/resources/trafic-moyen-journalier-annuel-sur-le-reseau-routier-national/20211222-165040/tmja-2019.csv'

// Lambert-93 (EPSG:2154) → WGS84
proj4.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs')
const toWGS84 = (x: number, y: number): [number, number] => {
  const [lon, lat] = proj4('EPSG:2154', 'WGS84', [x, y])
  return [lat, lon]
}

interface CensusSection {
  route: string        // "A0001", "N0007"
  ref: string          // normalized: "A1", "N7"
  lat: number
  lon: number
  tmja: number         // total AADT
  ratio_pl: number     // heavy vehicle share (0-1)
  aadt_light: number
  aadt_medium: number  // buses ~ 2% of PL
  aadt_heavy: number
  aadt_moto: number    // estimated ~1% of total
}

async function downloadTmja(): Promise<CensusSection[]> {
  if (!forceDownload && existsSync(CACHE_JSON)) {
    console.log(`  Using cached: ${CACHE_JSON}`)
    return JSON.parse(readFileSync(CACHE_JSON, 'utf-8'))
  }

  mkdirSync(CACHE_DIR, { recursive: true })

  // Download CSVs
  for (const [url, path, name] of [
    [TMJA_2024_URL, CACHE_2024, 'TMJA 2024 (RRNc)'],
    [TMJA_2019_URL, CACHE_2019, 'TMJA 2019 (full RRN)'],
  ] as const) {
    if (!forceDownload && existsSync(path)) {
      console.log(`  Using cached ${name}`)
      continue
    }
    if (enrichOnly && !existsSync(path)) {
      console.log(`  WARN: ${name} not cached, skipping`)
      continue
    }
    console.log(`  Downloading ${name}...`)
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`)
    writeFileSync(path, await res.text())
    console.log(`  Cached ${name}`)
  }

  return parseCsvFiles()
}

function parseCsvFiles(): CensusSection[] {
  const sections: CensusSection[] = []
  const seen = new Set<string>() // dedup by route + approximate position

  for (const [path, label] of [
    [CACHE_2024, 'TMJA 2024'],
    [CACHE_2019, 'TMJA 2019'],
  ] as const) {
    if (!existsSync(path)) continue
    const lines = readFileSync(path, 'utf-8').split('\n')
    const header = lines[0].split(';')

    const ci = (name: string) => header.indexOf(name)
    const iRoute = ci('route')
    const iTmja = ci('TMJA')
    const iRatioPL = ci('ratio_PL')
    const iXD = ci('xD')
    const iYD = ci('yD')
    const iXF = ci('xF')
    const iYF = ci('yF')

    let parsed = 0
    let skipped = 0
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(';')
      const route = cols[iRoute] || ''
      const tmja = parseFloat((cols[iTmja] || '').replace(',', '.'))
      const ratioPL = parseFloat((cols[iRatioPL] || '').replace(',', '.'))
      const xD = parseFloat((cols[iXD] || '').replace(',', '.'))
      const yD = parseFloat((cols[iYD] || '').replace(',', '.'))
      const xF = parseFloat((cols[iXF] || '').replace(',', '.'))
      const yF = parseFloat((cols[iYF] || '').replace(',', '.'))

      if (!route || !tmja || !xD || !yD || xD < 100000) { skipped++; continue }

      // Midpoint of section
      const mx = xF && yF ? (xD + xF) / 2 : xD
      const my = xF && yF ? (yD + yF) / 2 : yD
      const [lat, lon] = toWGS84(mx, my)

      if (lat < 41 || lat > 51.5 || lon < -5.5 || lon > 10) { skipped++; continue }

      // Normalize route: "A0001" → "A1", "N0007" → "N7"
      const ref = route.replace(/^([A-Z])0*/, '$1')

      // Dedup: prefer 2024 data over 2019
      const key = `${ref}:${lat.toFixed(2)}:${lon.toFixed(2)}`
      if (seen.has(key)) { skipped++; continue }
      seen.add(key)

      const ratioHV = isNaN(ratioPL) ? 0.12 : ratioPL / 100  // ratio_PL is percentage
      const motoFrac = 0.01  // ~1% motorcycle estimate for France
      const busFrac = 0.02   // ~2% of PL are buses

      const aadt_moto = Math.round(tmja * motoFrac)
      const totalHV = Math.round(tmja * ratioHV)
      const aadt_medium = Math.round(totalHV * busFrac)  // buses ~2% of heavy
      const aadt_heavy = totalHV - aadt_medium
      const aadt_light = Math.round(tmja - totalHV - aadt_moto)

      sections.push({ route, ref, lat, lon, tmja: Math.round(tmja), ratio_pl: ratioHV, aadt_light, aadt_medium, aadt_heavy, aadt_moto })
      parsed++
    }
    console.log(`  ${label}: ${parsed} sections, ${skipped} skipped`)
  }

  writeFileSync(CACHE_JSON, JSON.stringify(sections))
  console.log(`  Cached ${sections.length} sections to ${CACHE_JSON}`)
  return sections
}

function buildGrid(sections: CensusSection[]): Map<string, CensusSection[]> {
  const grid = new Map<string, CensusSection[]>()
  for (const s of sections) {
    const key = `${Math.floor(s.lat * 100)},${Math.floor(s.lon * 100)}`
    const list = grid.get(key) || []
    list.push(s)
    grid.set(key, list)
  }
  return grid
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function enrichArrows(sections: CensusSection[]) {
  const refIndex = new Map<string, CensusSection[]>()
  for (const s of sections) {
    const list = refIndex.get(s.ref) || []
    list.push(s)
    refIndex.set(s.ref, list)
  }
  console.log(`\n  Ref index: ${refIndex.size} unique road refs`)

  // Pre-filter French hexes via H3 center
  const allHexes = readdirSync(H3R4_DIR).filter(d => !d.startsWith('.'))
  const hexDirs: string[] = []
  for (const hex of allHexes) {
    try {
      const [lat, lon] = cellToLatLng(hex)
      if (lat > 41 && lat < 52 && lon > -6 && lon < 10) {
        if (existsSync(resolve(H3R4_DIR, hex, 'roads.arrow'))) hexDirs.push(hex)
      }
    } catch {}
  }
  console.log(`  French hexes: ${hexDirs.length}\n`)

  let totalSeg = 0, matched = 0, preserved = 0, hexesUpdated = 0
  const startTime = Date.now()

  for (let hi = 0; hi < hexDirs.length; hi++) {
    const hex = hexDirs[hi]
    const arrowPath = resolve(H3R4_DIR, hex, 'roads.arrow')
    const buf = readFileSync(arrowPath)
    const table = tableFromIPC(buf)
    const numRows = table.numRows
    const refs = table.getChild('ref')
    const startLats = table.getChild('start_lat')
    const startLons = table.getChild('start_lon')
    const endLats = table.getChild('end_lat')
    const endLons = table.getChild('end_lon')
    const existingSource = table.getChild('traffic_source')

    if (!startLats || !startLons) continue

    const aadtLight = new Int32Array(numRows)
    const aadtMedium = new Int32Array(numRows)
    const aadtHeavy = new Int32Array(numRows)
    const aadtMoto = new Int32Array(numRows)
    const trafficSource = new Uint8Array(numRows)
    let hexMatched = 0

    for (let i = 0; i < numRows; i++) {
      totalSeg++
      const existingSrc = existingSource?.get(i) ?? 0
      if (existingSrc === 1) {
        aadtLight[i] = table.getChild('aadt_light')?.get(i) ?? 0
        aadtMedium[i] = table.getChild('aadt_medium')?.get(i) ?? 0
        aadtHeavy[i] = table.getChild('aadt_heavy')?.get(i) ?? 0
        aadtMoto[i] = table.getChild('aadt_moto')?.get(i) ?? 0
        trafficSource[i] = 1
        preserved++
        continue
      }

      const midLat = ((startLats.get(i) ?? 0) + (endLats?.get(i) ?? startLats.get(i) ?? 0)) / 2
      const midLon = ((startLons.get(i) ?? 0) + (endLons?.get(i) ?? startLons.get(i) ?? 0)) / 2
      const osmRef = refs?.get(i)?.toString().trim() || ''
      // French OSM refs: "A 1", "N 7", "D 906"
      const normRef = osmRef.replace(/\s+/g, '')

      let best: CensusSection | null = null
      let bestDist = Infinity

      if (normRef && refIndex.has(normRef)) {
        for (const c of refIndex.get(normRef)!) {
          const dist = haversineM(midLat, midLon, c.lat, c.lon)
          if (dist < bestDist) { bestDist = dist; best = c }
        }
      }

      if (best && bestDist < 20000) {  // 20km for ref-matched sections
        aadtLight[i] = best.aadt_light
        aadtMedium[i] = best.aadt_medium
        aadtHeavy[i] = best.aadt_heavy
        aadtMoto[i] = best.aadt_moto
        trafficSource[i] = 1
        hexMatched++
        matched++
      }
    }

    if (hexMatched > 0) {
      const columns: Record<string, any> = {}
      for (const field of table.schema.fields) {
        if (['aadt_light', 'aadt_medium', 'aadt_heavy', 'aadt_moto', 'traffic_source'].includes(field.name)) continue
        columns[field.name] = table.getChild(field.name)!
      }
      columns['aadt_light'] = vectorFromArray(Array.from(aadtLight), new Int32())
      columns['aadt_medium'] = vectorFromArray(Array.from(aadtMedium), new Int32())
      columns['aadt_heavy'] = vectorFromArray(Array.from(aadtHeavy), new Int32())
      columns['aadt_moto'] = vectorFromArray(Array.from(aadtMoto), new Int32())
      columns['traffic_source'] = vectorFromArray(Array.from(trafficSource), new Uint8())
      const enriched = new table.constructor(columns)
      writeFileSync(arrowPath, tableToIPC(enriched, 'file'))
      hexesUpdated++
    }

    if (hi % 10 === 0) {
      console.log(`  [${Math.round((Date.now() - startTime) / 1000)}s] ${hi + 1}/${hexDirs.length} hexes, ${hexesUpdated} updated, ${matched} matched`)
    }
  }

  console.log(`\n=== Enrichment Results ===`)
  console.log(`  Total segments: ${totalSeg}`)
  console.log(`  Preserved: ${preserved}`)
  console.log(`  Newly matched: ${matched} (${(100 * matched / Math.max(totalSeg, 1)).toFixed(1)}%)`)
  console.log(`  Hexes updated: ${hexesUpdated}`)

  const top = sections.sort((a, b) => b.tmja - a.tmja).slice(0, 10)
  console.log(`\n  Top 10 AADT:`)
  for (const s of top) {
    console.log(`    ${s.ref.padEnd(6)} TMJA=${s.tmja.toLocaleString().padStart(7)} HV=${(s.ratio_pl * 100).toFixed(0)}%  (${s.lat.toFixed(2)}, ${s.lon.toFixed(2)})`)
  }
}

async function main() {
  console.log(`=== FR Road Traffic Enrichment (Cerema TMJA) ===\n`)
  console.log(`  H3R4 dir: ${H3R4_DIR}`)
  console.log(`  Cache: ${CACHE_DIR}\n`)

  const sections = await downloadTmja()
  console.log(`  Total sections: ${sections.length}`)

  const autoroutes = sections.filter(s => s.ref.startsWith('A'))
  const nationales = sections.filter(s => s.ref.startsWith('N'))
  console.log(`  Autoroutes (A): ${autoroutes.length}`)
  console.log(`  Nationales (N): ${nationales.length}`)

  await enrichArrows(sections)
  console.log(`\n=== Done ===`)
}

main().catch(err => { console.error(err); process.exit(1) })
